package `fun`.upup.musicfree.ffmpegDecoder

import android.net.Uri
import android.os.Build
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.ServerSocket
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Jellyfin FFmpeg 解码模块
 *
 * 对外暴露的 JS 接口见 src/native/ffmpegDecoder/index.ts。
 *
 * 运行前提：APK 的 jniLibs/<abi>/ 下打包了 Jellyfin FFmpeg 的可执行文件
 * （约定命名为 libjellyfin_ffmpeg.so，Android 只会从 APK 中解压以 lib 开头、
 *  以 .so 结尾的原生库）。模块首次调用时把它复制到 filesDir 下并 chmod 755
 *  后执行。
 */
class FFmpegDecoderModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "FFmpegDecoder"
        private const val LIB_NAME = "libjellyfin_ffmpeg.so"
        private const val BINARY_NAME = "jellyfin_ffmpeg"
        private const val STREAM_HOST = "127.0.0.1"
        private const val STREAM_BUFFER = 256 * 1024
    }

    override fun getName() = "FFmpegDecoder"

    /** ffmpeg 可执行文件路径，null 表示未集成 */
    private var binaryPath: String? = null
    private var binaryChecked = false

    /** 流式任务：源地址 -> StreamServer */
    private val streams = ConcurrentHashMap<String, StreamServer>()
    /** 转码任务：源地址 -> 进程 */
    private val transcodes = ConcurrentHashMap<String, Process>()

    // ------------------------------------------------------------------
    // 基础能力
    // ------------------------------------------------------------------

    /**
     * 定位 ffmpeg 可执行文件。
     * 优先级：filesDir 已释放的副本 > nativeLibraryDir 内的预打包产物
     */
    @Synchronized
    private fun ensureBinary(): String? {
        if (binaryChecked) {
            return binaryPath
        }
        binaryChecked = true
        try {
            val target = File(reactContext.filesDir, BINARY_NAME)
            val nativeDir = reactContext.applicationInfo.nativeLibraryDir
            val source = File(nativeDir, LIB_NAME)
            if (!source.exists()) {
                Log.w(TAG, "未找到预打包的 $LIB_NAME（$nativeDir），解码扩展不可用")
                binaryPath = null
                return null
            }
            // 每次启动都覆盖一次，保证与 APK 内版本一致
            if (!target.exists() || target.length() != source.length()) {
                source.inputStream().use { input ->
                    FileOutputStream(target).use { output -> input.copyTo(output) }
                }
            }
            target.setExecutable(true, false)
            if (!target.canExecute()) {
                Log.e(TAG, "ffmpeg 不可执行：${target.absolutePath}")
                binaryPath = null
                return null
            }
            binaryPath = target.absolutePath
            Log.i(TAG, "ffmpeg ready: ${target.absolutePath}")
            return binaryPath
        } catch (e: Exception) {
            Log.e(TAG, "释放 ffmpeg 失败", e)
            binaryPath = null
            return null
        }
    }

    @ReactMethod
    fun isAvailable(promise: Promise) {
        promise.resolve(ensureBinary() != null)
    }

    @ReactMethod
    fun getVersion(promise: Promise) {
        val bin = ensureBinary()
        if (bin == null) {
            promise.resolve(null)
            return
        }
        try {
            // exec 返回 (stdout, stderr, exitCode)，stdout 的首行即版本字符串
            val (stdout, _, _) = exec(bin, listOf("-hide_banner", "-version"), 5000)
            promise.resolve(stdout.firstOrNull()?.trim())
        } catch (e: Exception) {
            promise.reject("E_FFMPEG", e.message)
        }
    }

    // ------------------------------------------------------------------
    // 探测
    // ------------------------------------------------------------------

    /**
     * 探测音频信息。
     * jellyfin-ffmpeg 不一定带 ffprobe，这里用 `ffmpeg -i` 的 stderr 输出解析。
     */
    @ReactMethod
    fun probe(url: String, promise: Promise) {
        val bin = ensureBinary()
        if (bin == null) {
            promise.resolve(null)
            return
        }
        try {
            val input = resolveInput(url) ?: run {
                promise.reject("E_INPUT", "无法解析输入源: $url")
                return
            }
            // ffmpeg -i 无输出参数时退出码非 0，属预期行为，只看 stderr
            val err = exec(bin, listOf("-hide_banner", "-i", input.path), 8000).second
            val parsed = parseProbeOutput(err)
            input.release()
            if (parsed == null) {
                promise.resolve(null)
            } else {
                promise.resolve(parsed)
            }
        } catch (e: Exception) {
            promise.reject("E_PROBE", e.message)
        }
    }

    /** 解析 `ffmpeg -i` 的 stderr */
    private fun parseProbeOutput(err: List<String>): WritableMap? {
        val joined = err.joinToString("\n")
        val duration = Regex("Duration:\\s*(\\d+):(\\d+):(\\d+\\.?\\d*)")
            .find(joined)?.let {
                val (h, m, s) = it.destructured
                h.toDouble() * 3600 + m.toDouble() * 60 + s.toDouble()
            }
        val audio = Regex(
            "Audio:\\s*([a-z0-9_]+).*?(\\d+)\\s*Hz,?\\s*([a-z0-9_]+)?",
            RegexOption.IGNORE_CASE,
        ).find(joined)
        val bitrate = Regex("bitrate:\\s*(\\d+)\\s*kb/s", RegexOption.IGNORE_CASE)
            .find(joined)?.groupValues?.get(1)?.toLongOrNull()

        // 形如 "Audio: dsd_lsbf, 2822400 Hz, stereo, s32 (24 bit), 5645 kb/s"
        val codec = audio?.groupValues?.getOrNull(1)
        val sampleRate = audio?.groupValues?.getOrNull(2)?.toIntOrNull()
        val channelDesc = joined.substringAfter("Audio:").substringBefore("\n")
        val channels = parseChannels(channelDesc)

        if (duration == null && codec == null) {
            return null
        }
        return Arguments.createMap().apply {
            duration?.let { putDouble("duration", it) }
            codec?.let { putString("codec", it.lowercase(Locale.US)) }
            sampleRate?.let { putInt("sampleRate", it) }
            channels?.let { putInt("channels", it) }
            bitrate?.let { putInt("bitrate", (it * 1000).toInt()) }
            putString(
                "format",
                Regex("Input #0,\\s*([a-z0-9_,]+),", RegexOption.IGNORE_CASE)
                    .find(joined)?.groupValues?.getOrNull(1) ?: "unknown",
            )
            Regex("(\\d+)\\s*bit", RegexOption.IGNORE_CASE)
                .find(channelDesc)?.groupValues?.getOrNull(1)?.toIntOrNull()
                ?.let { putInt("bitsPerSample", it) }
        }
    }

    private fun parseChannels(desc: String): Int? {
        val d = desc.lowercase(Locale.US)
        return when {
            d.contains("mono") || d.contains("1 channel") -> 1
            d.contains("stereo") || d.contains("2 channel") -> 2
            d.contains("5.1") || d.contains("6 channel") -> 6
            d.contains("7.1") || d.contains("8 channel") -> 8
            else -> Regex("(\\d+)\\s*channel").find(d)?.groupValues?.getOrNull(1)?.toIntOrNull()
        }
    }

    // ------------------------------------------------------------------
    // 转码
    // ------------------------------------------------------------------

    /**
     * @param url      源地址（file:// / 绝对路径 / content://）
     * @param args     追加参数，例如 ["-c:a","flac","-f","flac"]
     * @param outputExt 目标扩展名，含点
     * @param target   输出绝对路径
     */
    @ReactMethod
    fun transcode(
        url: String,
        args: ReadableArray,
        outputExt: String,
        target: String,
        promise: Promise,
    ) {
        val bin = ensureBinary()
        if (bin == null) {
            promise.reject("E_FFMPEG", "ffmpeg 未集成")
            return
        }
        val argList = args.toArrayList().map { it.toString() }
        val input = try {
            resolveInput(url)
        } catch (e: Exception) {
            promise.reject("E_INPUT", e.message)
            return
        }
        if (input == null) {
            promise.reject("E_INPUT", "无法解析输入源: $url")
            return
        }
        val outFile = File(target)
        outFile.parentFile?.mkdirs()
        if (outFile.exists()) {
            outFile.delete()
        }

        val cmd = mutableListOf(bin, "-hide_banner", "-nostdin", "-loglevel", "error", "-y")
        cmd.add("-i")
        cmd.add(input.path)
        cmd.addAll(argList)
        cmd.add(outFile.absolutePath)

        try {
            val process = ProcessBuilder(cmd).apply {
                redirectErrorStream(true)
                environment()["TMPDIR"] = reactContext.cacheDir.absolutePath
            }.start()
            transcodes[url] = process
            // 必须消费 stdout/stderr，否则管道写满会阻塞
            val output = process.inputStream.bufferedReader().readText()
            val code = process.waitFor()
            transcodes.remove(url)
            input.release()
            if (code != 0 || !outFile.exists() || outFile.length() == 0L) {
                promise.reject("E_TRANSCODE", "ffmpeg 退出码 $code: ${output.take(500)}")
                return
            }
            promise.resolve(outFile.absolutePath)
        } catch (e: Exception) {
            transcodes.remove(url)
            input.release()
            promise.reject("E_TRANSCODE", e.message)
        }
    }

    @ReactMethod
    fun cancel(url: String, promise: Promise) {
        transcodes.remove(url)?.destroy()
        promise.resolve(true)
    }

    // ------------------------------------------------------------------
    // 流式解码（本地 HTTP）
    // ------------------------------------------------------------------

    /**
     * 起一个本地 HTTP 服务，把 ffmpeg 的输出边转边播。
     * @return http://127.0.0.1:<port>/stream<outputExt>
     */
    @ReactMethod
    fun startStream(url: String, args: ReadableArray, outputExt: String, promise: Promise) {
        val bin = ensureBinary()
        if (bin == null) {
            promise.reject("E_FFMPEG", "ffmpeg 未集成")
            return
        }
        streams[url]?.let {
            promise.resolve(it.url)
            return
        }
        val argList = args.toArrayList().map { it.toString() }
        val input = try {
            resolveInput(url)
        } catch (e: Exception) {
            promise.reject("E_INPUT", e.message)
            return
        }
        if (input == null) {
            promise.reject("E_INPUT", "无法解析输入源: $url")
            return
        }

        try {
            val server = StreamServer(url, bin, input, argList, outputExt)
            server.start()
            streams[url] = server
            promise.resolve(server.url)
        } catch (e: Exception) {
            input.release()
            promise.reject("E_STREAM", e.message)
        }
    }

    @ReactMethod
    fun stopStream(url: String, promise: Promise) {
        streams.remove(url)?.stop()
        promise.resolve(true)
    }

    private inner class StreamServer(
        private val source: String,
        private val bin: String,
        private val input: ResolvedInput,
        private val args: List<String>,
        private val outputExt: String,
    ) {
        private val serverSocket = ServerSocket(0, 1, java.net.InetAddress.getByName(STREAM_HOST))
        private val stopped = AtomicBoolean(false)
        private val cancelled = AtomicBoolean(false)
        private var process: Process? = null

        val url: String
            get() = "http://$STREAM_HOST:${serverSocket.localPort}/stream$outputExt"

        fun start() {
            thread(name = "ffmpeg-stream-accept") { acceptLoop() }
        }

        fun stop() {
            if (stopped.compareAndSet(false, true)) {
                cancelled.set(true)
                try {
                    process?.destroy()
                } catch (ignored: Exception) {
                }
                try {
                    serverSocket.close()
                } catch (ignored: Exception) {
                }
                input.release()
                streams.remove(source)
            }
        }

        private fun acceptLoop() {
            while (!stopped.get()) {
                val client = try {
                    serverSocket.accept()
                } catch (e: Exception) {
                    break
                }
                thread(name = "ffmpeg-stream-write") { serveOnce(client) }
            }
        }

        /**
         * 一个连接对应一次转码。ExoPlayer 会带 Range 重试，这里忽略 Range，
         * 始终从头开始推流（音频场景不需要断点续传）。
         */
        private fun serveOnce(client: java.net.Socket) {
            try {
                client.soTimeout = 30_000
                val cmd = mutableListOf(bin, "-hide_banner", "-nostdin", "-loglevel", "error")
                cmd.add("-i")
                cmd.add(input.path)
                cmd.addAll(args)
                cmd.add("pipe:1")
                val proc = ProcessBuilder(cmd).apply {
                    redirectErrorStream(false)
                    environment()["TMPDIR"] = reactContext.cacheDir.absolutePath
                }.start()
                process = proc
                // 丢弃 stderr，防止缓冲区满导致 ffmpeg 卡住
                thread(name = "ffmpeg-stream-err", isDaemon = true) {
                    try {
                        proc.errorStream.bufferedReader().readText()
                    } catch (ignored: Exception) {
                    }
                }

                val out = BufferedOutputStream(client.getOutputStream(), STREAM_BUFFER)
                val header = (
                    "HTTP/1.1 200 OK\r\n" +
                        "Content-Type: ${mimeOf(outputExt)}\r\n" +
                        "Connection: close\r\n" +
                        "Cache-Control: no-store\r\n" +
                        "Transfer-Encoding: chunked\r\n" +
                        "Accept-Ranges: none\r\n\r\n"
                    ).toByteArray(Charsets.US_ASCII)
                out.write(header)
                out.flush()

                proc.inputStream.use { stream ->
                    val buf = ByteArray(STREAM_BUFFER)
                    while (!cancelled.get()) {
                        val read = stream.read(buf)
                        if (read <= 0) break
                        // chunked 编码：长度行 + 数据 + CRLF
                        out.write((Integer.toHexString(read) + "\r\n").toByteArray(Charsets.US_ASCII))
                        out.write(buf, 0, read)
                        out.write("\r\n".toByteArray(Charsets.US_ASCII))
                    }
                }
                out.write("0\r\n\r\n".toByteArray(Charsets.US_ASCII))
                out.flush()
                proc.waitFor()
            } catch (e: Exception) {
                Log.w(TAG, "流式解码中断", e)
            } finally {
                try {
                    process?.destroy()
                } catch (ignored: Exception) {
                }
                try {
                    client.close()
                } catch (ignored: Exception) {
                }
            }
        }

        private fun mimeOf(ext: String): String = when (ext.lowercase(Locale.US)) {
            ".wav" -> "audio/wav"
            ".flac" -> "audio/flac"
            ".m4a" -> "audio/mp4"
            else -> "audio/*"
        }
    }

    override fun onCatalystInstanceDestroy() {
        super.onCatalystInstanceDestroy()
        streams.values.forEach { it.stop() }
        streams.clear()
        transcodes.values.forEach { it.destroy() }
        transcodes.clear()
    }

    // ------------------------------------------------------------------
    // 工具
    // ------------------------------------------------------------------

    /**
     * 输入源解析。
     * - content:// 走 /proc/self/fd 透传，失败则回退复制到临时文件
     * - file:// 与绝对路径直接使用
     */
    private fun resolveInput(url: String): ResolvedInput? {
        val uri = Uri.parse(url)
        return when (uri.scheme) {
            "content" -> resolveContentInput(uri)
            "file" -> ResolvedInput(uri.path ?: url)
            null -> ResolvedInput(url)
            else -> ResolvedInput(url)
        }
    }

    private fun resolveContentInput(uri: Uri): ResolvedInput? {
        // 方案一：通过 /proc/self/fd 让 ffmpeg 直接读到 fd，避免整文件复制
        try {
            val pfd = reactContext.contentResolver.openFileDescriptor(uri, "r")
            if (pfd != null) {
                val fd = pfd.fd
                val path = "/proc/self/fd/$fd"
                if (File(path).exists()) {
                    return ResolvedInput(path, pfd)
                }
                pfd.close()
            }
        } catch (e: Exception) {
            Log.w(TAG, "fd 透传失败，回退临时文件", e)
        }
        // 方案二：复制到缓存目录（大文件较慢，但兼容性最好）
        return try {
            val tmp = File(reactContext.cacheDir, "ffmpeg-in-${System.currentTimeMillis()}.tmp")
            reactContext.contentResolver.openInputStream(uri)?.use { input: InputStream ->
                FileOutputStream(tmp).use { output -> input.copyTo(output) }
            } ?: return null
            ResolvedInput(tmp.absolutePath, tempFile = tmp)
        } catch (e: Exception) {
            Log.e(TAG, "解析 content:// 输入失败", e)
            null
        }
    }

    /** 转码后的输入句柄：用完必须 release，避免 fd 泄漏与临时文件残留 */
    private class ResolvedInput(
        val path: String,
        private val pfd: android.os.ParcelFileDescriptor? = null,
        private val tempFile: File? = null,
    ) {
        fun release() {
            try {
                pfd?.close()
            } catch (ignored: Exception) {
            }
            try {
                tempFile?.delete()
            } catch (ignored: Exception) {
            }
        }
    }

    /** 执行一次性命令，返回 (stdout, stderr, exitCode) */
    private fun exec(
        bin: String,
        args: List<String>,
        timeoutMs: Long,
    ): Triple<List<String>, List<String>, Int> {
        val proc = ProcessBuilder(listOf(bin) + args).apply {
            redirectErrorStream(false)
        }.start()
        val stdout = proc.inputStream.bufferedReader().readLines()
        val stderr = proc.errorStream.bufferedReader().readLines()
        val finished = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            proc.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        } else {
            proc.waitFor()
            true
        }
        if (!finished) {
            proc.destroy()
        }
        return Triple(stdout, stderr, if (finished) proc.exitValue() else -1)
    }
}
