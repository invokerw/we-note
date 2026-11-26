package com.wenote.mobile

import android.app.Activity
import android.app.job.*
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

object NativeSync {
    init {
        System.loadLibrary("wenote_client")
    }

    @JvmStatic external fun generation(advance: Boolean): Long

    @JvmStatic external fun execute(action: String, payload: String): String
}

// Foreground and scheduler share one rotating refresh token. Serialize access across both.
private object Binding {
    private const val alias = "wenote-background-session"

    private fun file(ctx: Context) = AtomicFile(File(ctx.noBackupFilesDir, "sync-session"))

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let {
            return it
        }
        val generator = KeyGenerator.getInstance("AES", "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    @Synchronized
    fun read(ctx: Context): JSONObject? {
        val raw =
            try {
                file(ctx).readFully()
            } catch (_: java.io.FileNotFoundException) {
                return null
            }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8))
    }

    @Synchronized
    fun save(ctx: Context, binding: JSONObject) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.iv + cipher.doFinal(binding.toString().toByteArray(Charsets.UTF_8))
        val target = file(ctx)
        val stream = target.startWrite()
        try {
            stream.write(encrypted)
            target.finishWrite(stream)
        } catch (e: Exception) {
            target.failWrite(stream)
            throw e
        }
    }

    @Synchronized
    fun take(ctx: Context): JSONObject? {
        val old = read(ctx)
        file(ctx).delete()
        return old
    }

    @Synchronized
    fun access(ctx: Context): JSONObject {
        val binding = read(ctx) ?: error("后台同步已关闭")
        if (binding.getLong("expires") < System.currentTimeMillis() + 60000) {
            val next = JSONObject(NativeSync.execute("refresh", binding.toString()))
            binding
                .put("token", next.getString("access_token"))
                .put("refresh", next.getString("refresh_token"))
                .put("expires", next.getLong("expires_ms"))
            save(ctx, binding)
        }
        return binding
    }

    @Synchronized
    fun report(ctx: Context, generation: String, message: String) {
        val current = read(ctx) ?: return
        if (current.getString("generation") == generation)
            save(ctx, current.put("diagnostic", message))
    }
}

private const val jobId = 103

@TauriPlugin
class MobilePlugin(private val host: Activity) : Plugin(host) {
    private lateinit var noteWebView: android.webkit.WebView

    override fun load(webView: android.webkit.WebView) {
        noteWebView = webView
    }

    @Command
    fun printNote(invoke: Invoke) {
        val name = invoke.getArgs().getString("name")
        host.runOnUiThread {
            try {
                val manager = host.getSystemService(Context.PRINT_SERVICE) as android.print.PrintManager
                manager.print(name, noteWebView.createPrintDocumentAdapter(name), null)
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject(e.message)
            }
        }
    }

    private val scheduler
        get() = host.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler

    private val executor = Executors.newSingleThreadExecutor()

    private fun call(invoke: Invoke, work: () -> JSONObject?) {
        executor.execute {
            try {
                val result = work()
                if (result == null) invoke.resolve()
                else invoke.resolve(JSObject.fromJSONObject(result))
            } catch (e: Exception) {
                invoke.reject(e.message ?: "同步设置失败")
            }
        }
    }

    private fun schedule() {
        val job =
            JobInfo.Builder(jobId, ComponentName(host, SyncJob::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPeriodic(15 * 60 * 1000L)
                .setPersisted(true)
                .build()
        check(scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS) { "Android 未能安排后台同步" }
    }

    override fun onDestroy(activity: androidx.appcompat.app.AppCompatActivity) {
        executor.shutdown()
    }

    @Command
    fun restore(invoke: Invoke) =
        call(invoke) {
            Binding.read(host)?.also { if (scheduler.getPendingJob(jobId) == null) schedule() }
        }

    @Command fun access(invoke: Invoke) = call(invoke) { Binding.access(host) }

    @Command
    fun disable(invoke: Invoke) =
        call(invoke) {
            NativeSync.generation(true)
            scheduler.cancel(jobId)
            Binding.take(host)
        }

    @Command
    fun enable(invoke: Invoke) =
        call(invoke) {
            val binding =
                JSONObject(invoke.getRawArgs())
                    .put("generation", java.util.UUID.randomUUID().toString())
            Binding.save(host, binding)
            try {
                schedule()
            } catch (e: Exception) {
                Binding.take(host)
                throw e
            }
            binding
        }

    @Command
    fun exportDocument(invoke: Invoke) {
        val args = invoke.getArgs()
        val name = args.getString("name")
        val extension = name.substringAfterLast('.', "").lowercase()
        val mime =
            when (extension) {
                "xmind" -> "application/vnd.xmind.workbook"
                "json" -> "application/json"
                "md" -> "text/markdown"
                else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
                    ?: "application/octet-stream"
            }
        val intent =
            Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime)
                .putExtra(Intent.EXTRA_TITLE, name)
        startActivityForResult(invoke, intent, "documentSelected")
    }

    @ActivityCallback
    private fun documentSelected(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            invoke.resolve()
            return
        }
        call(invoke) {
            val bytes =
                android.util.Base64.decode(
                    invoke.getArgs().getString("data"),
                    android.util.Base64.DEFAULT,
                )
            require(bytes.size <= 16 * 1024 * 1024)
            requireNotNull(host.contentResolver.openOutputStream(uri, "wt")).use { it.write(bytes) }
            null
        }
    }

    @Command
    fun share(invoke: Invoke) {
        val args = invoke.getArgs()
        val send =
            Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_SUBJECT, args.getString("title"))
                .putExtra(Intent.EXTRA_TEXT, args.getString("text"))
        try {
            host.startActivity(Intent.createChooser(send, null))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message)
        }
    }
}

class SyncJob : JobService() {
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var active: JobParameters? = null

    override fun onStartJob(params: JobParameters): Boolean {
        active = params
        val job = NativeSync.generation(true)
        executor.execute {
            var generation = ""
            var retry = false
            try {
                generation = Binding.read(this)?.getString("generation") ?: return@execute
                val binding = Binding.access(this)
                if (active !== params || binding.getString("generation") != generation)
                    return@execute
                val report =
                    JSONObject(NativeSync.execute("sync", binding.put("job", job).toString()))
                Binding.report(
                    this,
                    generation,
                    "${java.util.Date()} · 上传 ${report.getInt("uploaded")} · 下载 ${report.getInt("downloaded")} · 冲突 ${report.getJSONArray("conflicts")}",
                )
            } catch (e: Exception) {
                retry = true
                Binding.report(this, generation, "${java.util.Date()} · ${e.message}")
            } finally {
                if (active === params) jobFinished(params, retry)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        NativeSync.generation(true)
        active = null
        return true
    }

    override fun onDestroy() {
        executor.shutdown()
        super.onDestroy()
    }
}
