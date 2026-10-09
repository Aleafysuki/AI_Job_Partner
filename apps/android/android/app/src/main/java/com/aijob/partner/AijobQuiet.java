package com.aijob.partner;

import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 静默模式的开关状态。
 *
 * 状态放在这里而不是服务里，是因为服务可能被系统重启（START_STICKY），
 * 而「用户是否处于静默录制中」这件事属于应用级状态，不应该随服务的生死而丢失。
 *
 * 之所以是静态字段而不是 SharedPreferences：静默模式是一次面试期间的有效状态，
 * 进程被杀本来就意味着录制已经中断（音频已经分片落盘、不会丢），
 * 此时应用重启后回到「非静默」才是正确的默认 —— 不该把上一次面试的静默状态
 * 带进下一次启动。
 */
final class AijobQuiet {

    private static volatile boolean on = false;

    private AijobQuiet() {}

    static boolean isOn() {
        return on;
    }

    static void markOn() {
        on = true;
    }

    static void markOff() {
        on = false;
    }

    /**
     * 打开/关闭静默模式，返回最终状态（与 DesktopBridge.quiet.set 的返回值一致）。
     *
     * options 的字段在 Android 上的映射：
     *   hideWindow —— 把任务挪到后台（moveTaskToBack），这是「面试时屏幕上不出现它」
     *                 在 Android 上唯一说得通的形态：不能让 App 消失，
     *                 否则用户连切换都做不到；
     *   showTray   —— Android 没有托盘。前台服务的常驻通知就是托盘图标的对应物，
     *                 且它**无法关闭**（见 AijobQuietService 的类注释）；
     *   hotkey     —— Android 没有全局快捷键，调用方会拿到 false，见下方 hotkey()。
     */
    static boolean set(Context context, boolean enable, boolean hideWindow) {
        if (enable) {
            Intent intent = new Intent(context, AijobQuietService.class).setAction(AijobQuietService.ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            markOn();
            if (hideWindow) hideWindow();
            return true;
        }

        Intent intent = new Intent(context, AijobQuietService.class).setAction(AijobQuietService.ACTION_STOP);
        context.startService(intent);
        markOff();
        return false;
    }

    /**
     * 把任务挪到后台。
     *
     * 这里**不能**先 startActivity 再把任务挪走 —— 那样会先闪一下界面
     * 再消失，正好是静默模式最不该发生的事。直接对当前 Activity 调
     * moveTaskToBack(true) 即可：任务整体退到后台，用户在最近任务里还能切回来。
     */
    private static void hideWindow() {
        MainActivity current = MainActivity.current();
        if (current != null) {
            current.moveTaskToBack(true);
        }
    }
}
