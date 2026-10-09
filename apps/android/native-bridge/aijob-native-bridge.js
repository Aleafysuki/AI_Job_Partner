/* ===========================================================================
 * AI Job Partner · Android 原生桥（JS 侧）
 * ===========================================================================
 *
 * 这个文件由 Android 构建在 index.html 的 <head> 最前面以普通 <script> 引入，
 * 因此它在应用主 bundle 之前执行 —— window.aijob 必须在此之前就位，
 * 因为 lib/bridge.ts 是在模块求值时读取 window.aijob 的（不是懒读）。
 *
 * ---------------------------------------------------------------------------
 * 为什么不用 Capacitor 的插件系统
 * ---------------------------------------------------------------------------
 * Capacitor 的插件要经过 `@capacitor/core` 的 JS 运行时才能把
 * `window.Capacitor.Plugins.X` 变成可调用代理，那就意味着渲染层要打包 Capacitor
 * 的 JS，桌面端与 Web 端也被迫带上一个它们永远不用的运行时。
 *
 * 改成「原生侧暴露一个通用 RPC 入口 + 这个脚本把它适配成 window.aijob」有两点好处：
 *   1. 渲染层零新增依赖，DesktopBridge 契约一个字都不用改
 *      —— 桌面端那套实现与这里的实现在同一个契约下并排存在；
 *   2. 这一半是纯 JS，可以在没有 Android SDK 的机器上真实验证
 *      （见 apps/desktop/scripts/mobile-smoke.cjs 会注入假的 AijobNative 来跑它）。
 *      只有 Kotlin 那一半需要真机。
 *
 * ---------------------------------------------------------------------------
 * 契约
 * ---------------------------------------------------------------------------
 * 原生侧（addJavascriptInterface 注入的对象，见 AijobBridge.kt）：
 *
 *   AijobNative.invoke(callId: string, channel: string, payloadJson: string): void
 *       异步。结果通过下面两个回调回灌，避免阻塞 WebView 的 JS 桥线程。
 *
 *   window.__aijobResolve(callId, ok: boolean, payloadJson: string)
 *       一次调用的结果。ok=false 时 payloadJson 形如 {"message": "..."}。
 *
 *   window.__aijobEvent(name: string, payloadJson: string)
 *       原生主动推送的事件。当前只有 quiet.stopRequested
 *       —— 静默模式下窗口不可见，用户从通知里要求结束录制时必须有人告诉页面。
 *
 * 为什么二进制走 base64：JSON 表达不了字节数组，而 writeSegment / readBytes
 * 都要传音频与文件字节。Electron 那边由结构化克隆代劳，这里得自己编解码。
 */
(function () {
  'use strict';

  // 没有原生侧对象 = 正在桌面端 / 浏览器预览里跑这份产物。
  // 此时**刻意不定义** window.aijob：bridge.ts 会据此正确退化到 localStorage，
  // 而不是拿到一个所有方法都会失败的空壳。
  var native = window.AijobNative;
  if (!native || typeof native.invoke !== 'function') return;

  // -------------------------------------------------------------------------
  // base64 ↔ Uint8Array
  // -------------------------------------------------------------------------

  /** 单次 String.fromCharCode 的入参上限。整块传入会撑爆调用栈（几十兆音频必炸） */
  var CHUNK = 0x8000;

  function bytesToBase64(bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var binary = '';
    for (var i = 0; i < u8.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    var binary = atob(base64);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  var seq = 0;
  var pending = {};
  var listeners = {};

  /**
   * 原生 → 页面的事件名。
   *
   * 为什么集中成一张表、而不是在用到的地方直接写字符串：
   * apps/android/scripts/check-native.mjs 会拿这里和 Java 侧 emitEvent() 的名字
   * 逐字比对。对不上时的现象是「静默模式下用户点「结束录制」没有任何反应」——
   * 而两边的代码看上去都是对的，界面上也不报错，是最难查的一类故障。
   */
  var EVENTS = {
    stopRequested: 'quiet.stopRequested',
  };

  /**
   * 超时不是防「慢」，是防「原生侧抛异常导致 Promise 永远挂着」。
   * 面试复盘要上传几十兆音频再等转写，所以给得足够宽；
   * 真正的失败仍由原生侧主动 reject，超时只是最后一层保险。
   */
  var TIMEOUT_MS = 180000;

  window.__aijobResolve = function (callId, ok, payloadJson) {
    var entry = pending[callId];
    if (!entry) return; // 已经超时或被清理，丢弃即可
    delete pending[callId];
    clearTimeout(entry.timer);

    var data = null;
    try {
      data = payloadJson ? JSON.parse(payloadJson) : null;
    } catch (err) {
      data = null;
    }

    if (ok) {
      entry.resolve(data);
    } else {
      entry.reject(new Error((data && data.message) || '原生调用失败'));
    }
  };

  window.__aijobEvent = function (name, payloadJson) {
    var list = listeners[name];
    if (!list || list.length === 0) return;
    var data = null;
    try {
      data = payloadJson ? JSON.parse(payloadJson) : null;
    } catch (err) {
      data = null;
    }
    // 复制一份再遍历：回调里可能会退订自己
    list.slice().forEach(function (handler) {
      try {
        handler(data);
      } catch (err) {
        // 单个订阅者抛错不能影响其他订阅者
      }
    });
  };

  function invoke(channel, payload) {
    return new Promise(function (resolve, reject) {
      seq += 1;
      var callId = 'c' + seq;
      var timer = setTimeout(function () {
        if (pending[callId]) {
          delete pending[callId];
          reject(new Error('原生调用超时：' + channel));
        }
      }, TIMEOUT_MS);

      pending[callId] = { resolve: resolve, reject: reject, timer: timer };

      try {
        native.invoke(callId, channel, JSON.stringify(payload || {}));
      } catch (err) {
        delete pending[callId];
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // window.aijob —— 与 src/shared/ipc.ts 的 DesktopBridge 逐字段对齐
  // -------------------------------------------------------------------------

  var aijob = {
    // 语义是「是否存在原生桥」，不是「是不是桌面端」。
    // 各 describe() 里的用户可见文案按 hostKind 取，不读这个字段。
    isDesktop: true,

    appInfo: function () {
      return invoke('appInfo', {});
    },

    storage: {
      load: function () {
        return invoke('storage.load', {});
      },
      save: function (snapshot) {
        return invoke('storage.save', { snapshot: snapshot });
      },
      clear: function () {
        return invoke('storage.clear', {});
      },
    },

    /**
     * 出网。
     *
     * 这里必须手工处理 bodyBytes：core 的 HttpRequest 用 Uint8Array 传音频分片
     * （见 packages/core/src/ai/types.ts 的注释），而 Uint8Array 直接进 JSON.stringify
     * 会变成 {"0":1,"1":2,…} 这种下标对象 —— 原生侧收到的将不是音频，
     * 而是一个看起来像数据、实际毫无意义的映射。转写会安静地失败。
     *
     * Electron 那边不需要这一步，因为它的 IPC 走结构化克隆，Uint8Array 能原样过去。
     * 平台差异就集中在这一处。
     */
    http: function (request) {
      var payload = {
        url: request.url,
        method: request.method,
        headers: request.headers || {},
        body: request.body || null,
        timeoutMs: request.timeoutMs,
      };
      if (request.bodyBytes) {
        payload.bodyBase64 = bytesToBase64(request.bodyBytes);
      }
      return invoke('http.request', { request: payload });
    },

    // 选择简历文件。取消时原生返回 null，这里保持 null（调用方据此判断「用户取消」）
    pickFile: function () {
      return invoke('file.pick', {}).then(function (r) {
        return r || null;
      });
    },

    readBytes: function (path) {
      return invoke('file.readBytes', { path: path }).then(function (r) {
        return base64ToBytes(r.base64);
      });
    },

    /*
     * 截图 OCR（v0.3 job.input_image）—— 只提供「选图」这一个动作。
     *
     * 识别本身在 WebView 里做（tesseract WASM，模型随应用打包），
     * 与桌面端同一份 JS 实现。初版这里接的是原生 ML Kit，已撤回 ——
     * 理由见 app/build.gradle 里的撤回记录。
     *
     * 所以原生侧只需要复用文件选择器（MIME 限为 image/*），
     * 字节由已有的 file.readBytes 提供。
     */
    pickImage: function () {
      return invoke('ocr.pick', {}).then(function (r) {
        return r || null;
      });
    },

    saveText: function (defaultName, content) {
      return invoke('file.saveText', { defaultName: defaultName, content: content });
    },

    openExternal: function (url) {
      return invoke('app.openExternal', { url: url });
    },

    capture: {
      begin: function (sessionId) {
        return invoke('capture.begin', { sessionId: sessionId });
      },
      writeSegment: function (sessionId, fileName, bytes) {
        return invoke('capture.writeSegment', {
          sessionId: sessionId,
          fileName: fileName,
          base64: bytesToBase64(bytes),
        });
      },
      readSegment: function (sessionId, fileName) {
        return invoke('capture.readSegment', { sessionId: sessionId, fileName: fileName }).then(function (r) {
          return base64ToBytes(r.base64);
        });
      },
      finish: function (sessionId) {
        return invoke('capture.finish', { sessionId: sessionId });
      },
      discard: function (sessionId) {
        return invoke('capture.discard', { sessionId: sessionId }).then(function () {
          return undefined;
        });
      },
      openFolder: function (sessionId) {
        return invoke('capture.openFolder', { sessionId: sessionId }).then(function () {
          return undefined;
        });
      },
      freeSpace: function () {
        return invoke('capture.freeSpace', {});
      },
    },

    media: {
      requestMic: function () {
        return invoke('media.requestMic', {});
      },
      setSystemAudio: function (enabled) {
        return invoke('media.setSystemAudio', { enabled: enabled });
      },
      listSources: function () {
        return invoke('media.listSources', {});
      },
    },

    quiet: {
      set: function (on, options) {
        return invoke('quiet.set', { on: on, options: options || null });
      },
      isOn: function () {
        return invoke('quiet.isOn', {});
      },
      /**
       * 静默模式下的安全出口：窗口不可见时，用户只能从常驻通知点「结束录制」。
       * 原生侧收到后发出 quiet.stopRequested，这里转交给页面去收尾
       * （MediaRecorder 是页面里的对象，原生侧碰不到）。
       * 返回退订函数，与 Electron 版的 IPC 订阅保持同一签名。
       */
      onStopRequested: function (handler) {
        var name = EVENTS.stopRequested;
        if (!listeners[name]) listeners[name] = [];
        listeners[name].push(handler);
        return function () {
          var list = listeners[name] || [];
          var at = list.indexOf(handler);
          if (at >= 0) list.splice(at, 1);
        };
      },
    },

    hotkey: function (action, accelerator) {
      return invoke('hotkey.set', { action: action, accelerator: accelerator });
    },

    saveHtml: function (defaultName, html) {
      return invoke('file.saveHtml', { defaultName: defaultName, html: html });
    },
  };

  Object.defineProperty(window, 'aijob', {
    value: aijob,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  // 给冒烟测试与排障用的标记：能一眼看出原生桥脚本确实跑到了
  window.__aijobBridgeReady = true;
})();
