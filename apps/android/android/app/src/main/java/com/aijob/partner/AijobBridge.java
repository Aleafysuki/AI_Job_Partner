package com.aijob.partner;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * 原生桥：把 src/shared/ipc.ts 里的 DesktopBridge 契约在 Android 上实现一遍。
 *
 * ===========================================================================
 * 设计要点
 * ===========================================================================
 *
 * 【一】为什么是一个通用 RPC 入口，而不是六个 Capacitor 插件
 *   Capacitor 的插件要经过 @capacitor/core 的 JS 运行时，才把
 *   window.Capacitor.Plugins.X 变成可调用代理 —— 那意味着渲染层要打包
 *   Capacitor 的 JS，桌面端与 Web 端也被迫带上一个永远不用的运行时。
 *   改成「一个 invoke + JS 侧适配成 window.aijob」之后：
 *     - 渲染层零新增依赖，DesktopBridge 契约一个字都不用改；
 *     - JS 那一半（native-bridge/aijob-native-bridge.js）是纯 JS，
 *       在没有 Android SDK 的机器上也能真实验证；
 *     - 只有本文件需要真机。
 *
 * 【二】线程模型
 *   @JavascriptInterface 的方法跑在 WebView 的 JS 桥线程上（不是主线程）。
 *   所以：
 *     - HTTP / SQLite / 文件读写直接在调用线程做（它们本来就是阻塞操作）；
 *     - 需要 Activity、权限、系统选择器的操作 post 到主线程，
 *       把 callId 记进 active* 字段，等系统回调回来再 resolve。
 *   resolve 一律回主线程执行 evaluateJavascript。
 *
 * 【三】二进制为什么走 base64
 *   JSON 表达不了字节数组。Electron 那边由结构化克隆代劳，这里得自己编解码。
 *   http 通道最容易错：Uint8Array 进 JSON.stringify 会变成 {"0":1,"1":2,…}，
 *   所以 JS 侧先转成 bodyBase64，见 aijob-native-bridge.js 的 http 实现。
 *
 * 【四】Android 上做不到的三件事（如实返回失败，不假装成功）
 *   1. hotkey  —— Android 没有全局快捷键。静默模式的安全出口改成
 *                 前台服务通知里的「结束录制」按钮（见 AijobQuietService）；
 *   2. 系统内录 —— 见 setSystemAudio 的实现注释；
 *   3. 打开文件夹 —— Android 没有「打开目录」这个动作，只能定位到目录里的第一个文件。
 */
public final class AijobBridge {

    /** 注入到页面里的对象名。JS 侧读 window.AijobNative */
    public static final String JS_NAME = "AijobNative";

    static final int REQ_PICK_FILE = 1001;
    static final int REQ_SAVE_DOC = 1002;
    static final int REQ_MIC = 1003;

    /** 单个文件读入内存的上限。简历与离线报告都远小于此，超了说明用户选错文件 */
    private static final int MAX_BYTES = 32 * 1024 * 1024;

    private final BridgeActivity activity;
    private final AijobStore store;
    private final AijobCapture capture;
    /*
     * 截图 OCR 不在原生侧做（见 app/build.gradle 里那段撤回记录）：
     * ML Kit 的公开 API 类不在这条依赖链里，而 OCR 在 WebView 里跑
     * tesseract WASM 与桌面端共用同一份实现。
     * 这里只提供 `ocr.pick` —— 复用文件选择器，限制 MIME 为 image/*。
     */
    private final OkHttpClient http;
    private final ExecutorService workers = Executors.newFixedThreadPool(3);
    private final Handler main = new Handler(Looper.getMainLooper());

    /** 等待系统回调的调用。系统一次只可能弹一个选择器，所以每个用途一个槽位就够 */
    private volatile Pending activePick;
    private volatile Pending activeSave;
    private volatile Pending activeMic;

    private static final class Pending {
        final String callId;
        final String title;
        final boolean asHtml;

        Pending(String callId, String title, boolean asHtml) {
            this.callId = callId;
            this.title = title;
            this.asHtml = asHtml;
        }
    }

    AijobBridge(BridgeActivity activity) {
        this.activity = activity;
        this.store = new AijobStore(activity);
        this.capture = new AijobCapture(activity);
        this.http = new OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            // 读超时给足：转写接口要等服务端把整段音频过一遍
            .readTimeout(180, TimeUnit.SECONDS)
            .writeTimeout(180, TimeUnit.SECONDS)
            .build();

        // 通知栏「结束录制」-> 页面里的 quiet.stopRequested，
        // 这样渲染层的 quietPort.onStopRequested 在两个宿主下行为一致
        AijobQuietService.onStopRequested = () -> emitEvent("quiet.stopRequested", new JSONObject());
    }

    // =========================================================================
    // 入口
    // =========================================================================

    @JavascriptInterface
    public void invoke(String callId, String channel, String payloadJson) {
        final JSONObject payload;
        try {
            payload = payloadJson == null || payloadJson.isEmpty() ? new JSONObject() : new JSONObject(payloadJson);
        } catch (JSONException err) {
            fail(callId, "无法解析调用参数：" + err.getMessage());
            return;
        }

        try {
            dispatch(callId, channel, payload);
        } catch (Exception err) {
            fail(callId, err.getMessage() == null ? err.toString() : err.getMessage());
        }
    }

    private void dispatch(String callId, String channel, JSONObject payload) {
        switch (channel) {
            // ---- 运行环境 ----
            case "appInfo":
                workers.execute(() -> ok(callId, appInfo()));

                // ---- 存储 ----
                break;
            case "storage.load":
                workers.execute(() -> {
                    String raw = store.read(AijobStore.KEY_WORKSPACE);
                    // 契约要求「没有快照时返回 null」，这里直接回一个 JSON null，
                    // 让渲染层走首次使用流程，而不是拿到一个空对象当档案
                    resolve(callId, true, raw == null ? "null" : raw);
                });
                break;
            case "storage.save":
                workers.execute(() -> {
                    JSONObject snapshot = payload.optJSONObject("snapshot");
                    if (snapshot == null) {
                        fail(callId, "storage.save 缺少 snapshot");
                        return;
                    }
                    try {
                        store.write(AijobStore.KEY_WORKSPACE, snapshot.toString());
                        resolve(callId, true, "null");
                    } catch (Exception err) {
                        fail(callId, "写入本地数据库失败：" + err.getMessage());
                    }
                });
                break;
            case "storage.clear":
                workers.execute(() -> {
                    store.delete(AijobStore.KEY_WORKSPACE);
                    resolve(callId, true, "null");
                });
                break;

            // ---- 出网 ----
            case "http.request":
                workers.execute(() -> httpRequest(callId, payload));
                break;

            // ---- 文件 ----
            case "file.pick":
                filePick(callId);
                break;
            case "file.readBytes":
                workers.execute(() -> fileReadBytes(callId, payload));
                break;
            case "file.saveText":
                fileSave(callId, payload, false);
                break;
            case "file.saveHtml":
                fileSave(callId, payload, true);
                break;
            case "ocr.pick":
                ocrPick(callId);
                break;
            case "app.openExternal":
                main.post(() -> openExternal(callId, payload));
                break;

            // ---- 录音落盘 ----
            case "capture.begin":
                workers.execute(() -> captureOp(callId, () -> capture.begin(payload.optString("sessionId"))));
                break;
            case "capture.writeSegment":
                workers.execute(() -> captureOp(callId, () -> capture.writeSegment(
                    payload.optString("sessionId"),
                    payload.optString("fileName"),
                    decodeBase64(payload.optString("base64"))
                )));
                break;
            case "capture.readSegment":
                workers.execute(() -> captureOp(callId, () -> {
                    byte[] bytes = capture.readSegment(payload.optString("sessionId"), payload.optString("fileName"));
                    JSONObject out = new JSONObject();
                    out.put("base64", encodeBase64(bytes));
                    return out;
                }));
                break;
            case "capture.finish":
                workers.execute(() -> captureOp(callId, () -> capture.finish(payload.optString("sessionId"))));
                break;
            case "capture.discard":
                workers.execute(() -> captureOp(callId, () -> {
                    capture.discard(payload.optString("sessionId"));
                    return null;
                }));
                break;
            case "capture.openFolder":
                main.post(() -> captureOp(callId, () -> {
                    capture.openFolder(payload.optString("sessionId"));
                    return null;
                }));
                break;
            case "capture.freeSpace":
                workers.execute(() -> captureOp(callId, capture::freeSpace));
                break;

            // ---- 麦克风 ----
            case "media.requestMic":
                mediaRequestMic(callId);
                break;
            case "media.setSystemAudio":
                setSystemAudio(callId);
                break;
            case "media.listSources":
                // 没有可内录的屏幕源可列（见 setSystemAudio 的说明）
                ok(callId, "[]");
                break;

            // ---- 静默模式 ----
            case "quiet.set":
                quietSet(callId, payload);
                break;
            case "quiet.isOn":
                ok(callId, String.valueOf(AijobQuiet.isOn()));
                break;
            case "hotkey.set":
                // Android 没有全局快捷键这个概念，这个通道在本平台上恒为 false。
                // 静默模式的安全出口由前台服务的常驻通知承担 —— 那比快捷键更好找，
                // 因为通知就摆在用户眼前，而快捷键需要记住。
                ok(callId, "false");
                break;

            default:
                fail(callId, "未知的调用通道：" + channel);
        }
    }

    // =========================================================================
    // appInfo
    // =========================================================================

    private String appInfo() {
        JSONObject versions = new JSONObject();
        JSONObject out = new JSONObject();
        try {
            // electron / node 这两个字段是给桌面端用的。Android 上如实填「—」，
            // 而不是编一个看起来像版本号的东西 —— 界面上的透明度靠真话堆出来。
            versions.put("electron", "—");
            versions.put("node", "—");
            versions.put("chrome", chromiumVersion());

            out.put("name", "AI Job Partner");
            out.put("version", "0.2.0");
            out.put("release", "v0.2");
            out.put("platform", "Android " + Build.VERSION.RELEASE + "（API " + Build.VERSION.SDK_INT + "）");
            out.put("storageLocation", new File(activity.getFilesDir(), "aijob.db").getAbsolutePath());
            out.put("storageEngine", "Android SQLite（WAL，应用私有目录）");
            out.put("versions", versions);
        } catch (JSONException ignored) {
            // JSONObject.put(String, String) 不抛，这里只是让编译器安心
        }
        return out.toString();
    }

    /** 从 WebView 的默认 UA 里取 Chromium 版本；取不到就说取不到 */
    private String chromiumVersion() {
        try {
            String ua = WebSettings.getDefaultUserAgent(activity);
            int at = ua.indexOf("Chrome/");
            if (at < 0) return "未知";
            int end = ua.indexOf(' ', at);
            return end < 0 ? ua.substring(at + 7) : ua.substring(at + 7, end);
        } catch (Exception err) {
            return "未知";
        }
    }

    // =========================================================================
    // 出网
    // =========================================================================

    private void httpRequest(String callId, JSONObject payload) {
        JSONObject request = payload.optJSONObject("request");
        if (request == null) {
            fail(callId, "http.request 缺少 request");
            return;
        }

        String url = request.optString("url");
        String method = request.optString("method", "POST");
        int timeoutMs = request.optInt("timeoutMs", 60000);

        try {
            Request.Builder builder = new Request.Builder().url(url);

            JSONObject headers = request.optJSONObject("headers");
            if (headers != null) {
                JSONArray names = headers.names();
                if (names != null) {
                    for (int i = 0; i < names.length(); i += 1) {
                        String name = names.getString(i);
                        // OkHttp 对 header 名做校验，非法名会抛异常；
                        // 这里跳过而不是整个请求失败，避免一个多余的 header 让分析全挂
                        try {
                            builder.header(name, headers.optString(name, ""));
                        } catch (IllegalArgumentException ignored) {
                            // 忽略非法 header
                        }
                    }
                }
            }

            RequestBody body = null;
            String bodyBase64 = request.optString("bodyBase64", null);
            String bodyText = request.optString("body", null);
            if (bodyBase64 != null && !bodyBase64.isEmpty()) {
                // 音频分片走这条：JS 侧把 Uint8Array 转成了 base64
                MediaType type = MediaType.parse(resolveContentType(headers));
                body = RequestBody.create(decodeBase64(bodyBase64), type);
            } else if (bodyText != null && !bodyText.isEmpty()) {
                MediaType type = MediaType.parse(resolveContentType(headers));
                body = RequestBody.create(bodyText, type);
            }

            if ("GET".equalsIgnoreCase(method)) {
                builder.get();
            } else {
                builder.method(method, body == null ? RequestBody.create(new byte[0], null) : body);
            }

            OkHttpClient client = http.newBuilder()
                .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build();

            try (Response response = client.newCall(builder.build()).execute()) {
                String text = response.body() == null ? "" : response.body().string();
                JSONObject out = new JSONObject();
                out.put("ok", response.isSuccessful());
                out.put("status", response.code());
                out.put("text", text);
                ok(callId, out);
            }
        } catch (IOException err) {
            // 网络层错误（DNS / 超时 / 连接被拒）与 HTTP 错误分开报，
            // 渲染层靠 networkError 是否存在来决定要不要提示「检查网络」
            JSONObject out = new JSONObject();
            try {
                out.put("ok", false);
                out.put("status", 0);
                out.put("text", "");
                out.put("networkError", err.getMessage() == null ? err.toString() : err.getMessage());
            } catch (JSONException ignored) {
                // 不会发生
            }
            ok(callId, out);
        } catch (Exception err) {
            fail(callId, "请求失败：" + err.getMessage());
        }
    }

    private static String resolveContentType(JSONObject headers) {
        if (headers == null) return "application/octet-stream";
        for (String name : new String[] { "Content-Type", "content-type" }) {
            String value = headers.optString(name, null);
            if (value != null && !value.isEmpty()) return value;
        }
        return "application/octet-stream";
    }

    // =========================================================================
    // 文件
    // =========================================================================

    private void filePick(String callId) {
        activePick = new Pending(callId, null, false);
        main.post(() -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            // 与渲染层 <input accept> 保持同一组类型，
            // 这样两个宿主下「哪些文件能选」是一致的
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                "text/plain",
                "text/markdown",
                "application/pdf",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            });
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                activity.startActivityForResult(intent, REQ_PICK_FILE);
            } catch (ActivityNotFoundException err) {
                activePick = null;
                fail(callId, "系统里没有可用的文件选择器");
            }
        });
    }

    private void fileSave(String callId, JSONObject payload, boolean asHtml) {
        String defaultName = payload.optString("defaultName", asHtml ? "report.html" : "report.json");
        // 内容必须先存下来：ACTION_CREATE_DOCUMENT 的回调里只拿得到目标 URI，
        // 拿不到要写的内容 —— 而内容在用户挑位置之前就已经由渲染层给出来了。
        // 系统一次只可能弹一个文档选择器，所以一个字段够用。
        lastSaveContent = payload.optString("content", "");
        activeSave = new Pending(callId, defaultName, asHtml);
        main.post(() -> {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(asHtml ? "text/html" : "application/json");
            intent.putExtra(Intent.EXTRA_TITLE, defaultName);
            try {
                activity.startActivityForResult(intent, REQ_SAVE_DOC);
            } catch (ActivityNotFoundException err) {
                activeSave = null;
                fail(callId, "系统里没有可用的保存位置选择器");
            }
        });
    }

    /**
     * 选一张图片用于 OCR。
     *
     * 与 filePick 的区别只有 MIME 过滤：这里只允许图片。
     * 复用同一个 REQ_PICK_FILE 与 activePick —— 系统一次只可能弹一个选择器，
     * 所以不需要两套 pending 状态。
     */
    private void ocrPick(String callId) {
        activePick = new Pending(callId, null, false);
        main.post(() -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("image/*");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                activity.startActivityForResult(intent, REQ_PICK_FILE);
            } catch (ActivityNotFoundException err) {
                activePick = null;
                fail(callId, "系统里没有可用的图片选择器");
            }
        });
    }

    private void fileReadBytes(String callId, JSONObject payload) {
        String path = payload.optString("path", "");
        try {
            byte[] bytes;
            if (path.startsWith("content://")) {
                bytes = readUriBytes(Uri.parse(path));
            } else {
                bytes = java.nio.file.Files.readAllBytes(new File(path).toPath());
            }
            JSONObject out = new JSONObject();
            out.put("base64", encodeBase64(bytes));
            ok(callId, out);
        } catch (Exception err) {
            fail(callId, "读取文件失败：" + err.getMessage());
        }
    }

    private byte[] readUriBytes(Uri uri) throws IOException {
        InputStream in = activity.getContentResolver().openInputStream(uri);
        if (in == null) throw new IOException("无法打开该文件");
        try {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[64 * 1024];
            int total = 0;
            int read;
            while ((read = in.read(chunk)) > 0) {
                total += read;
                // 上限保护：宁可明确报错，也不要把内存吃满被系统杀掉 ——
                // 被杀掉的话用户连「为什么失败」都看不到
                if (total > MAX_BYTES) throw new IOException("文件过大（超过 32MB）");
                buffer.write(chunk, 0, read);
            }
            return buffer.toByteArray();
        } finally {
            in.close();
        }
    }

    private String displayNameOf(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = activity.getContentResolver().query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // 取不到就退回 URI 的最后一段
        } finally {
            if (cursor != null) cursor.close();
        }
        String last = uri.getLastPathSegment();
        return last == null ? "未命名文件" : last;
    }

    private void openExternal(String callId, JSONObject payload) {
        String url = payload.optString("url", "");
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            resolve(callId, true, "null");
        } catch (Exception err) {
            fail(callId, "无法打开链接：" + err.getMessage());
        }
    }

    /** 系统选择器 / 权限框的回调入口。由 MainActivity 转发 */
    boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_FILE) {
            Pending pending = activePick;
            activePick = null;
            if (pending == null) return true;

            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
                // 用户取消是正常路径，不是错误：契约里 pickFile 明确可以返回 null
                resolve(pending.callId, true, "null");
                return true;
            }

            Uri uri = data.getData();
            String callId = pending.callId;
            workers.execute(() -> {
                try {
                    JSONObject out = new JSONObject();
                    // path 就是 content URI —— 渲染层随后会拿它调 readBytes
                    out.put("path", uri.toString());
                    out.put("name", displayNameOf(uri));
                    out.put("size", uriSize(uri));
                    ok(callId, out);
                } catch (Exception err) {
                    fail(callId, "读取所选文件失败：" + err.getMessage());
                }
            });
            return true;
        }

        if (requestCode == REQ_SAVE_DOC) {
            Pending pending = activeSave;
            activeSave = null;
            if (pending == null) return true;

            if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
                resolve(pending.callId, true, "null");
                return true;
            }

            Uri uri = data.getData();
            String callId = pending.callId;
            String content = lastSaveContent;
            lastSaveContent = null;

            workers.execute(() -> {
                try {
                    writeUri(uri, content == null ? "" : content);
                    JSONObject out = new JSONObject();
                    out.put("name", displayNameOf(uri));
                    ok(callId, out);
                } catch (Exception err) {
                    fail(callId, "写入文件失败：" + err.getMessage());
                }
            });
            return true;
        }

        return false;
    }

    /**
     * 待写内容暂存。
     *
     * 为什么要存成字段：ACTION_CREATE_DOCUMENT 的回调里只拿得到目标 URI，
     * 拿不到要写的内容 —— 内容在用户选位置之前就已经由渲染层给出来了。
     * 系统一次只会有一个文档选择器，所以一个字段足够。
     */
    private volatile String lastSaveContent;

    private long uriSize(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = activity.getContentResolver().query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index);
            }
        } catch (Exception ignored) {
            // 拿不到就返回 -1，渲染层只是展示用
        } finally {
            if (cursor != null) cursor.close();
        }
        return -1;
    }

    private void writeUri(Uri uri, String content) throws IOException {
        OutputStream out = activity.getContentResolver().openOutputStream(uri, "wt");
        if (out == null) throw new IOException("无法写入所选位置");
        try {
            out.write(content.getBytes(StandardCharsets.UTF_8));
            out.flush();
        } finally {
            out.close();
        }
    }

    // =========================================================================
    // 麦克风
    // =========================================================================

    private void mediaRequestMic(String callId) {
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            try {
                ok(callId, micResult(true));
            } catch (JSONException err) {
                fail(callId, "无法读取音频设备信息");
            }
            return;
        }

        activeMic = new Pending(callId, null, false);
        main.post(() -> ActivityCompat.requestPermissions(activity, new String[] { Manifest.permission.RECORD_AUDIO }, REQ_MIC));
    }

    /** 权限框回调。由 MainActivity 转发 */
    boolean onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQ_MIC) return false;
        Pending pending = activeMic;
        activeMic = null;
        if (pending == null) return true;

        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        try {
            ok(pending.callId, micResult(granted));
        } catch (JSONException err) {
            fail(pending.callId, "无法读取音频设备信息");
        }
        return true;
    }

    private String micResult(boolean granted) throws JSONException {
        JSONObject out = new JSONObject();

        if (!granted) {
            out.put("status", "denied");
            out.put("reason", "没有录音权限。Android 不允许后台录音，所以这个权限必须在系统弹窗里同意");
            return out.toString();
        }

        // 有权限还要确认真的有输入设备：某些模拟器与定制系统会返回空列表，
        // 这时候如果只说「已授权」，用户会在面试结束后才发现一个字都没录上
        List<String> inputs = new ArrayList<>();
        AudioManager manager = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
        if (manager != null) {
            for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_INPUTS)) {
                int type = device.getType();
                if (type == AudioDeviceInfo.TYPE_BUILTIN_MIC || type == AudioDeviceInfo.TYPE_WIRED_HEADSET || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_USB_DEVICE) {
                    inputs.add(device.getProductName() == null ? "音频输入设备" : device.getProductName().toString());
                }
            }
        }

        if (inputs.isEmpty()) {
            out.put("status", "unavailable");
            out.put("reason", "系统没有报告任何可用的音频输入设备");
            return out.toString();
        }

        JSONArray devices = new JSONArray();
        for (int i = 0; i < inputs.size(); i += 1) {
            JSONObject device = new JSONObject();
            // deviceId 只是给界面展示用的标识，Android 不允许按 id 指定输入源，
            // 实际采集永远走系统默认输入
            device.put("deviceId", "input-" + i);
            device.put("label", inputs.get(i));
            devices.put(device);
        }

        out.put("status", "granted");
        out.put("reason", "已获得录音权限，系统报告 " + inputs.size() + " 个输入设备");
        out.put("devices", devices);
        return out.toString();
    }

    /**
     * 系统内录（loopback）。
     *
     * Android 从 10 起提供了 AudioPlaybackCapture，但它的前提是**被录的那一方同意**：
     * 目标应用可以在自己的清单里写 android:allowAudioPlaybackCapture="false" 关掉。
     * 而会议类应用（线上笔试、视频面试客户端）几乎都会关掉它 —— 一个面试工具去录
     * 面试官的声音，正是这个开关被设计出来要防的事情。
     *
     * 所以这里如实返回 false，并把原因写清楚，让渲染层按「本平台不支持内录」
     * 降级为只录麦克风。这与项目在 macOS / Linux 上处理内录的做法是同一个套路
     * （见 docs/ROADMAP.md 的已知问题表），只是原因更硬：不是缺驱动，是平台不允许。
     *
     * 不假装成功尤其重要：这个方法的返回值决定界面上要不要显示「正在录制对方的声音」。
     */
    private void setSystemAudio(String callId) {
        ok(callId, "false");
    }

    // =========================================================================
    // 静默模式
    // =========================================================================

    private void quietSet(String callId, JSONObject payload) {
        final boolean on = payload.optBoolean("on", false);
        JSONObject options = payload.optJSONObject("options");
        final boolean hideWindow = options != null && options.optBoolean("hideWindow", false);

        main.post(() -> {
            try {
                AijobQuiet.set(activity, on, hideWindow);
                ok(callId, String.valueOf(on));
            } catch (Exception err) {
                fail(callId, "无法切换静默模式：" + err.getMessage());
            }
        });
    }

    // =========================================================================
    // 录音落盘（统一包一层异常处理，免得每个 case 里重复 try）
    // =========================================================================

    private interface CaptureTask {
        Object run() throws Exception;
    }

    private void captureOp(String callId, CaptureTask task) {
        try {
            Object result = task.run();
            resolve(callId, true, result == null ? "null" : result.toString());
        } catch (Exception err) {
            fail(callId, err.getMessage() == null ? err.toString() : err.getMessage());
        }
    }

    // =========================================================================
    // 回灌
    // =========================================================================

    private void ok(String callId, Object data) {
        resolve(callId, true, data == null ? "null" : data.toString());
    }

    private void fail(String callId, String message) {
        JSONObject err = new JSONObject();
        try {
            err.put("message", message);
        } catch (JSONException ignored) {
            // 不会发生
        }
        resolve(callId, false, err.toString());
    }

    /**
     * 回灌一次调用结果。
     *
     * 用 JSONArray 拼参数而不是手写字符串转义：payload 是任意 JSON
     * （可能含引号、反斜杠、换行、中文），手写转义是这类桥最经典的漏洞来源。
     * JSONArray.toString() 保证产出合法 JSON，而 `apply(null, [...])`
     * 正好对应 __aijobResolve(callId, ok, payloadJson) 的形参。
     */
    private void resolve(String callId, boolean success, String payloadJson) {
        main.post(() -> {
            WebView webView = webViewOrNull();
            if (webView == null) return;
            JSONArray args = new JSONArray();
            args.put(callId);
            args.put(success);
            args.put(payloadJson == null ? JSONObject.NULL : payloadJson);
            webView.evaluateJavascript("window.__aijobResolve.apply(null, " + args + ");", null);
        });
    }

    /** 原生主动推事件（目前只有静默模式的「要求结束录制」） */
    private void emitEvent(String name, JSONObject payload) {
        main.post(() -> {
            WebView webView = webViewOrNull();
            if (webView == null) return;
            JSONArray args = new JSONArray();
            args.put(name);
            args.put(payload == null ? "{}" : payload.toString());
            webView.evaluateJavascript("window.__aijobEvent.apply(null, " + args + ");", null);
        });
    }

    private WebView webViewOrNull() {
        try {
            return activity.getBridge() == null ? null : activity.getBridge().getWebView();
        } catch (Exception err) {
            return null;
        }
    }

    // =========================================================================
    // base64
    // =========================================================================

    private static String encodeBase64(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.NO_WRAP);
    }

    private static byte[] decodeBase64(String base64) {
        if (base64 == null || base64.isEmpty()) return new byte[0];
        return Base64.decode(base64, Base64.DEFAULT);
    }
}
