package com.aijob.partner;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * 静默模式的前台服务。
 *
 * ---------------------------------------------------------------------------
 * 这个类存在的第一个理由是「不被系统杀掉」，第二个理由是「必须留一个出口」
 * ---------------------------------------------------------------------------
 * 静默模式下主界面退到后台、屏幕上不出现任何提示。Android 会在内存紧张时
 * 回收后台进程 —— 进程一死，WebView 里的 MediaRecorder 就断了，而录音是不可再生的。
 * 前台服务是唯一能保证进程存活的手段。
 *
 * 但前台服务**必须**常驻一条通知，这是 Android 的硬性要求，没有 API 可以绕过。
 * 于是这里出现了一个与产品边界的正面冲突：
 *
 *   产品要求   「面试期间不弹任何提示」
 *   Android 要求「长时间录音必须显示常驻通知」
 *
 * 这一条无法调和，只能如实处理：
 *   1. 通知通道用 IMPORTANCE_LOW：不出声、不震动、不弹 heads-up，
 *      只在通知栏和状态栏留一个图标。这是系统允许的最低可见度；
 *   2. 通知里放「结束录制」按钮 —— 既然它必须存在，就让它承担正事：
 *      它是静默模式下用户唯一能停掉录制的入口（对应桌面端的托盘菜单）；
 *   3. 在界面上、在 docs/ANDROID.md 里都写明这一条与桌面端不同。
 *
 * 把它做成「悄悄录、用户停不掉」的话，这个功能就变成了恶意软件的形状。
 */
public class AijobQuietService extends Service {

    static final String ACTION_START = "com.aijob.partner.quiet.START";
    static final String ACTION_STOP = "com.aijob.partner.quiet.STOP";
    static final String ACTION_REQUEST_STOP = "com.aijob.partner.quiet.REQUEST_STOP";

    static final int NOTIFICATION_ID = 0x4149; // 'AI'
    private static final String CHANNEL_ID = "aijob.quiet";

    /**
     * 系统通知里点「结束录制」时调用。
     * 由 AijobBridge 在 WebView 就绪后注册，内部会转成页面里的
     * quiet.stopRequested 事件 —— MediaRecorder 是页面对象，原生侧停不掉。
     */
    static volatile Runnable onStopRequested;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_STOP.equals(action)) {
            AijobQuiet.markOff();
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_REQUEST_STOP.equals(action)) {
            // 只是「请求」结束：真正停 MediaRecorder 的动作在页面里，
            // 页面收尾完会自己调 quiet.set(false) 把服务关掉。
            // 这里不直接停服务，否则页面还没来得及落盘最后一段分片。
            Runnable handler = onStopRequested;
            if (handler != null) handler.run();
            return START_NOT_STICKY;
        }

        // ACTION_START 或系统重启服务（intent 为 null）都要确保处于前台状态，
        // 否则 Android 会在几秒内抛 ANR/RemoteServiceException 把进程干掉
        startAsForeground();
        return START_STICKY;
    }

    /** 依据麦克风权限选择前台服务类型 —— 类型与权限不匹配会抛 SecurityException */
    private void startAsForeground() {
        boolean micGranted = ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;

        int type;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && micGranted) {
            // microphone 类型才能在锁屏/后台继续拿到音频输入
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // 还没有麦克风权限时先按 dataSync 起（用于保住进程与 WebView），
            // 等用户在界面上授权麦克风后 quiet.set 会再来一次，届时切成 microphone
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
        } else {
            type = 0;
        }

        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
    }

    private Notification buildNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, getString(R.string.quiet_channel_name), NotificationManager.IMPORTANCE_LOW);
            channel.setDescription(getString(R.string.quiet_channel_desc));
            channel.setShowBadge(false);
            // 关掉震动与呼吸灯：通道建好之后再改只有部分机型生效，
            // 所以这里在建通道这一步就把能关的都关掉
            channel.enableVibration(false);
            channel.enableLights(false);
            channel.setSound(null, null);
            manager.createNotificationChannel(channel);
        }

        Intent stopIntent = new Intent(this, AijobQuietService.class).setAction(ACTION_REQUEST_STOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent stopPending = PendingIntent.getService(this, 0, stopIntent, flags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.quiet_notification_title))
            .setContentText(getString(R.string.quiet_notification_text))
            .setSmallIcon(R.drawable.ic_stat_recording)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .addAction(0, getString(R.string.quiet_notification_action), stopPending)
            .build();
    }
}
