package com.aijob.partner;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.annotation.NonNull;

import com.getcapacitor.BridgeActivity;

/**
 * Android 宿主入口。
 *
 * 原内容留痕（Capacitor 生成的空壳，勿删）：
 *     public class MainActivity extends BridgeActivity {}
 *
 * 继承 Capacitor 的 BridgeActivity：WebView 的构建、本地 https 虚拟源、
 * 生命周期、返回键、插件加载都由它处理，这里只做三件 Capacitor 不知道的事：
 *
 *   1. 装原生桥（window.AijobNative）—— 让渲染层的 lib/bridge.ts 拿到
 *      与桌面端同一个 window.aijob 契约，从而一条业务代码都不用改；
 *   2. 把系统回调（文件选择器、权限框）转发给 AijobBridge；
 *   3. 保证静默录制期间进程不被系统回收：靠 AijobQuietService 这个前台服务，
 *      以及 onResume 里的 setKeepScreenOn(true)。
 *      注意这里**没有**覆盖 onPause —— 核查 Capacitor 源码后确认
 *      BridgeActivity.onPause 并不会暂停 WebView、也不会冻结页面定时器，
 *      覆盖它只会引入「不调 super」的危险写法。详见文件下方的「原设计留痕」。
 */
public class MainActivity extends BridgeActivity {

    private static volatile MainActivity instance;

    private AijobBridge aijob;

    /** 供 AijobQuiet 调用（静默模式要把任务挪到后台） */
    static MainActivity current() {
        return instance;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        installBridge();
    }

    /**
     * 把原生桥挂到 WebView 上。
     *
     * 为什么在 onCreate 之后立刻做、而不是等页面加载完：
     * 应用主 bundle 是 type="module"（defer），而原生桥脚本
     * （aijob-native-bridge.js，由构建注入到 <head> 最前面）会在主 bundle 之前执行，
     * 它在执行时就要求 window.AijobNative 存在。
     * 若等 onPageFinished 再注入，主 bundle 早已把 window.aijob 读成 undefined，
     * 之后整份应用都会走 localStorage 回退 —— 能用，但数据没进原生 SQLite。
     */
    private void installBridge() {
        WebView webView = webViewOrNull();
        if (webView == null) return;

        if (aijob == null) aijob = new AijobBridge(this);
        // 重复调用只是替换同名对象，幂等
        webView.addJavascriptInterface(aijob, AijobBridge.JS_NAME);
    }

    private WebView webViewOrNull() {
        try {
            return getBridge() == null ? null : getBridge().getWebView();
        } catch (Exception err) {
            return null;
        }
    }

    @Override
    public void onResume() {
        super.onResume();

        // WebView 有可能被系统回收后重建，这里补挂一次
        installBridge();

        // 录制期间（静默模式）保证屏幕不休眠：
        // 一次面试可能四五十分钟，用户全程不会碰这台手机。
        WebView webView = webViewOrNull();
        if (webView != null) {
            webView.setKeepScreenOn(AijobQuiet.isOn());
        }
    }

    /* =======================================================================
     * 原设计留痕（已废弃，请勿恢复）
     * -----------------------------------------------------------------------
     * 这里原本有一个 onPause 覆盖：
     *
     *     @Override
     *     protected void onPause() {
     *         // 静默录制中刻意不暂停 WebView
     *         if (AijobQuiet.isOn()) return;
     *         super.onPause();
     *     }
     *
     * 它在「不调 super.onPause()」和「解决一个不存在的问题」两点上都错了，
     * 是首次真机编译时暴露出来的（本机没有 Android SDK 时无法发现）：
     *
     * 一、覆盖方法不能把访问权限改小。Capacitor 的 BridgeActivity 把
     *     onResume/onPause 声明为 public（见 BridgeActivity.java 第 94、104 行），
     *     子类写成 protected 会直接编译失败：
     *     「正在尝试分配更低的访问权限; 以前为public」。
     *
     * 二、静默录制时跳过 super.onPause() 是有害的。Android 要求 Activity 把
     *     生命周期回调交给父类，不交给父类会让框架层与 Activity 对「当前是否
     *     处于 paused」的认知不一致，属于危险写法。
     *
     * 三、更根本的是：这个覆盖想防的事根本不会发生。翻 Capacitor 源码可见
     *     BridgeActivity.onPause() 只做两件事——通知插件 handleOnPause、
     *     让 Cordova 兼容层停下来（Bridge.onPause）。
     *     全仓搜索 webView.onPause / pauseTimers / resumeTimers 三个调用**一个都没有**，
     *     也就是说 Capacitor 从不暂停自己的 WebView，也不会冻结页面里的 JS 定时器。
     *
     * 真正会打断录音的是「整个进程被系统冻结或回收」——那是 Android 的后台
     * 执行限制，属于前台服务的职责，见 AijobQuietService。
     * 所以正确做法就是什么都不覆盖，让生命周期照常走。
     * ======================================================================= */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        // 只接管自己的请求码，其余（含 Capacitor 插件的）交回父类
        if (aijob != null && aijob.onActivityResult(requestCode, resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        if (aijob != null && aijob.onRequestPermissionsResult(requestCode, permissions, grantResults)) return;
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }
}
