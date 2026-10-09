package com.aijob.partner;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.Comparator;

/**
 * 面试录音的分片落盘。
 *
 * 与桌面端 apps/desktop/src/main/capture.ts 一一对应，只是根目录从
 * Electron 的 userData 换成了 Android 的应用私有目录：
 *
 *     files/recordings/<sessionId>/seg-0001.webm
 *
 * 为什么放应用私有目录而不是公共音乐目录：
 *   录音里是面试对话，属于最不该被其他 App 随手扫到的一类文件。
 *   私有目录对其他应用不可见，卸载即清除，符合「数据只在本机、不建账号」的承诺。
 *   代价是用户不能直接用文件管理器翻到 —— 所以 openFolder 走 FileProvider
 *   交给系统的「打开方式」，由用户显式选择接收方。
 *
 * 为什么音频不进 SQLite：见 AijobStore 的类注释。
 */
final class AijobCapture {

    private static final String ROOT = "recordings";

    private final Context context;

    AijobCapture(Context context) {
        this.context = context;
    }

    private File sessionDir(String sessionId) {
        // sessionId 来自渲染层的会话 id。这里做一次白名单校验，
        // 防止 '../../../databases' 这类构造把写入位置挪出录音目录。
        if (sessionId == null || !sessionId.matches("[A-Za-z0-9_-]{1,64}")) {
            throw new IllegalArgumentException("非法的会话 id");
        }
        return new File(new File(context.getFilesDir(), ROOT), sessionId);
    }

    /** 会话音频目录的绝对路径（给人看的，会出现在界面上） */
    String directoryOf(String sessionId) {
        return sessionDir(sessionId).getAbsolutePath();
    }

    JSONObject begin(String sessionId) throws JSONException, IOException {
        File dir = sessionDir(sessionId);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("无法创建录音目录：" + dir.getAbsolutePath());
        }
        JSONObject out = new JSONObject();
        out.put("sessionId", sessionId);
        out.put("directory", dir.getAbsolutePath());
        return out;
    }

    JSONObject writeSegment(String sessionId, String fileName, byte[] bytes) throws IOException, JSONException {
        // 分片文件名同样只允许 <名字>.<3 位扩展名>，理由同 sessionId
        if (fileName == null || !fileName.matches("[A-Za-z0-9_.-]{1,64}")) {
            throw new IllegalArgumentException("非法的分片文件名");
        }
        File dir = sessionDir(sessionId);
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("无法创建录音目录：" + dir.getAbsolutePath());
        }

        File target = new File(dir, fileName);
        // 覆盖式写入：同一分片重试时不应该留下两份，也不应该追加（会拼出坏文件）
        try (FileOutputStream out = new FileOutputStream(target, false)) {
            out.write(bytes);
            out.flush();
            // 关键：音频不可再生。不 fsync 的话进程被杀会在文件系统里留下 0 字节文件。
            out.getFD().sync();
        }

        JSONObject result = new JSONObject();
        result.put("bytes", bytes.length);
        return result;
    }

    byte[] readSegment(String sessionId, String fileName) throws IOException {
        if (fileName == null || !fileName.matches("[A-Za-z0-9_.-]{1,64}")) {
            throw new IllegalArgumentException("非法的分片文件名");
        }
        File file = new File(sessionDir(sessionId), fileName);
        return java.nio.file.Files.readAllBytes(file.toPath());
    }

    JSONObject finish(String sessionId) throws JSONException {
        File dir = sessionDir(sessionId);
        JSONObject out = new JSONObject();
        out.put("sessionId", sessionId);
        out.put("directory", dir.getAbsolutePath());

        JSONArray files = new JSONArray();
        long total = 0;
        File[] list = dir.listFiles();
        if (list != null) {
            // 按文件名排序 = 按录制顺序排序（seg-0001 / seg-0002 …），
            // 转写时必须按这个顺序拼接，否则对话会乱
            Arrays.sort(list, Comparator.comparing(File::getName));
            for (File file : list) {
                if (!file.isFile()) continue;
                JSONObject item = new JSONObject();
                item.put("fileName", file.getName());
                item.put("bytes", file.length());
                files.put(item);
                total += file.length();
            }
        }

        out.put("fileCount", files.length());
        out.put("totalBytes", total);
        out.put("files", files);
        return out;
    }

    /** 删除整个会话的音频。调用方（渲染层）已经让用户显式确认过 */
    void discard(String sessionId) {
        deleteRecursively(sessionDir(sessionId));
    }

    private static void deleteRecursively(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        // 删不掉（例如仍在被播放）不算失败：留一份残文件比抛异常打断收尾流程要好
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /**
     * 在系统文件管理器里打开录音目录。
     *
     * 应用私有目录不能直接给外部看，所以用 FileProvider 生成一个可授权的内容 URI，
     * 交给系统的查看器。Android 里没有「打开文件夹」，只能定位到里面的第一个文件，
     * 这一点与桌面端的 shell.openPath 行为不同，在界面上要如实说明。
     */
    void openFolder(String sessionId) throws IOException {
        File dir = sessionDir(sessionId);
        File[] list = dir.listFiles();
        if (list == null || list.length == 0) {
            throw new IOException("这个会话还没有音频文件");
        }
        Arrays.sort(list, Comparator.comparing(File::getName));

        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", list[0]);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "audio/webm");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    JSONObject freeSpace() throws JSONException {
        long free = AijobStore.usableSpace(context);
        JSONObject out = new JSONObject();
        out.put("freeBytes", free);
        out.put("directory", new File(context.getFilesDir(), ROOT).getAbsolutePath());
        // 阈值与桌面端保持一致（200MB）：低于这个数就提示用户，
        // 一次一小时的双声道面试音频大约几十兆
        out.put("isLow", free >= 0 && free < 200L * 1024 * 1024);
        return out;
    }
}
