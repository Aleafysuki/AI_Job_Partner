package com.aijob.partner;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

/**
 * 工作区快照的原生存储（SQLite）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是「一张 kv 表」而不是把 snapshot 拆成关系表
 * ---------------------------------------------------------------------------
 * 因为 StoragePort 契约本身就是**文档式**的：
 *     load()   -> WorkspaceSnapshot | null
 *     save(snapshot) -> void
 *     clear()  -> void
 * 它没有「按技能查一条」这种查询语义。把文档硬拆成关系表，会得到一个
 * 既没有查询收益、又要为每次 save 写一套 upsert/delete-missing 逻辑的存储层
 * —— 这是把契约的形状当成建模缺陷来修。
 *
 * 那 SQLite 在这里相对 localStorage 的价值是什么（换掉 localStorage 的三条理由）：
 *   1. 没有 5MB 配额。一份积累了多个岗位、几十条证据、多份报告的快照会超；
 *   2. 写入是原子的。localStorage 中途失败会留下半截 JSON，下次 load 直接抛异常，
 *      用户看到的是「档案没了」；
 *   3. 可导出、可备份、可用工具查看，符合「数据只在本机、但属于用户」的产品承诺。
 *
 * 音频字节**不在这里**：那走文件系统（见 AijobCapture），
 * 因为一次面试几十次 persist，把几兆的音频塞进快照会让每次 save 都变成大文件重写。
 * 这一条与 docs/ARCHITECTURE.md 的取舍完全一致。
 */
final class AijobStore extends SQLiteOpenHelper {

    private static final String DB_NAME = "aijob.db";
    private static final int DB_VERSION = 1;

    /** 工作区快照的固定主键。契约里只有一个文档，所以键是常量。 */
    static final String KEY_WORKSPACE = "workspace";

    private static final String TABLE = "kv";

    AijobStore(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE " + TABLE + " (" + "k TEXT NOT NULL PRIMARY KEY, " + "v TEXT NOT NULL, " + "updated_at INTEGER NOT NULL" + ")");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // 目前只有 v1。以后加版本时在这里写迁移，不要 DROP ——
        // 用户的能力档案是不可再生的，重建等于让他从头再写一遍简历。
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        // WAL：写入不阻塞读取，且崩溃时不会留下损坏的主库文件
        db.enableWriteAheadLogging();
    }

    /** 读一个文档。不存在返回 null（契约要求，调用方据此进入首次使用流程） */
    synchronized String read(String key) {
        Cursor cursor = null;
        try {
            cursor = getReadableDatabase().query(TABLE, new String[] { "v" }, "k = ?", new String[] { key }, null, null, null);
            if (!cursor.moveToFirst()) return null;
            return cursor.getString(0);
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    /** 写一个文档。整条记录替换，天然原子 */
    synchronized void write(String key, String value) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            db.execSQL("INSERT OR REPLACE INTO " + TABLE + " (k, v, updated_at) VALUES (?, ?, ?)", new Object[] { key, value, System.currentTimeMillis() });
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    synchronized void delete(String key) {
        getWritableDatabase().delete(TABLE, "k = ?", new String[] { key });
    }

    /** 数据目录剩余空间。录制前提示用，也是 freeSpace 通道的数据来源 */
    static long usableSpace(Context context) {
        return context.getFilesDir().getUsableSpace();
    }
}
