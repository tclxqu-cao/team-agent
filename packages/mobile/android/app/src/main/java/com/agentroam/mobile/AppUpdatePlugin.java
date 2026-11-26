package com.agentroam.mobile;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name = "AgentRoamAppUpdate")
public class AppUpdatePlugin extends Plugin {
    private static final String RELEASES = "https://github.com/tclxqu-cao/team-agent/releases/download/";
    private static final Pattern VERSION = Pattern.compile("(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-preview\\.(?:0|[1-9][0-9]*))?");
    private static final Pattern SHA256 = Pattern.compile("[a-f0-9]{64}");
    private static final long MAX_BYTES = 512L * 1024 * 1024;
    private final AtomicBoolean installing = new AtomicBoolean();

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            PackageInfo installed = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            call.resolve(new JSObject().put("version", installed.versionName));
        } catch (PackageManager.NameNotFoundException error) {
            call.reject("无法读取当前应用版本");
        }
    }

    @PluginMethod
    public void install(PluginCall call) {
        String version = call.getString("version", "");
        String sha256 = call.getString("sha256", "");
        if (version.length() > 64 || !VERSION.matcher(version).matches() || !SHA256.matcher(sha256).matches()) {
            call.reject("更新版本或校验摘要无效");
            return;
        }
        if (!installing.compareAndSet(false, true)) {
            call.reject("正在安装更新");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            publish("installing", 0, "请在系统设置中允许安装应用");
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            getBridge().executeOnMainThread(() -> launch(call, settings, "permissionFinished"));
        } else {
            downloadInBackground(call);
        }
    }

    @ActivityCallback
    private void permissionFinished(PluginCall call, ActivityResult result) {
        if (call == null) { installing.set(false); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            fail(call, "请允许 AgentRoam 安装应用后重试");
            return;
        }
        downloadInBackground(call);
    }

    private void downloadInBackground(PluginCall call) {
        String version = call.getString("version");
        String sha256 = call.getString("sha256");
        new Thread(() -> {
            File apk = pendingApk();
            try {
                File directory = apk.getParentFile();
                if (!directory.mkdirs() && !directory.isDirectory()) throw new IOException("无法创建更新目录");
                String fileName = "AgentRoam-" + version + "-android.apk";
                download(new URL(RELEASES + "android-v" + version + "/" + fileName), apk, sha256);
                verifyUpgrade(apk, version);
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent installer = new Intent(Intent.ACTION_INSTALL_PACKAGE)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                publish("installing", 100, "请在 Android 安装界面确认更新");
                getBridge().executeOnMainThread(() -> launch(call, installer, "installFinished"));
            } catch (Exception error) {
                fail(call, error instanceof IOException ? error.getMessage() : "无法验证 Android 更新包");
            }
        }, "agentroam-app-update").start();
    }

    private void download(URL url, File apk, String expectedDigest) throws Exception {
        HttpsURLConnection connection = openDownload(url);
        try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(apk)) {
            long size = connection.getContentLengthLong();
            if (size > MAX_BYTES) throw new IOException("APK 大小异常");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            long downloaded = 0;
            long deadline = SystemClock.elapsedRealtime() + 15 * 60_000L;
            int progress = 0;
            publish("downloading", progress, null);
            for (int length; (length = input.read(buffer)) != -1;) {
                downloaded += length;
                if (downloaded > MAX_BYTES || (size >= 0 && downloaded > size)) throw new IOException("APK 大小异常");
                if (SystemClock.elapsedRealtime() > deadline) throw new IOException("APK 下载超时");
                digest.update(buffer, 0, length);
                output.write(buffer, 0, length);
                int next = size > 0 ? (int) Math.min(99, downloaded * 100 / size) : 0;
                if (next > progress) {
                    progress = next;
                    publish("downloading", progress, null);
                }
            }
            StringBuilder actual = new StringBuilder(64);
            for (byte value : digest.digest()) actual.append(String.format(Locale.ROOT, "%02x", value & 0xff));
            if (!expectedDigest.contentEquals(actual)) throw new IOException("APK 校验失败");
        } finally {
            connection.disconnect();
        }
    }

    private HttpsURLConnection openDownload(URL url) throws IOException {
        for (int redirect = 0; redirect < 5; redirect++) {
            String host = url.getHost();
            if (!"https".equals(url.getProtocol()) || !("github.com".equals(host) || host.endsWith(".githubusercontent.com"))) {
                throw new IOException("APK 下载地址无效");
            }
            HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(30_000);
            connection.setInstanceFollowRedirects(false);
            int status = connection.getResponseCode();
            if (status == 200) return connection;
            String location = connection.getHeaderField("Location");
            connection.disconnect();
            if (status < 300 || status >= 400 || location == null) throw new IOException("APK 下载失败 (HTTP " + status + ")");
            url = new URL(url, location);
        }
        throw new IOException("APK 下载重定向过多");
    }

    @SuppressWarnings("deprecation")
    private void verifyUpgrade(File apk, String version) throws Exception {
        PackageManager manager = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo installed = manager.getPackageInfo(getContext().getPackageName(), flags);
        PackageInfo candidate = manager.getPackageArchiveInfo(apk.getAbsolutePath(), flags);
        if (candidate == null || !installed.packageName.equals(candidate.packageName) || !version.equals(candidate.versionName)
            || PackageInfoCompat.getLongVersionCode(candidate) <= PackageInfoCompat.getLongVersionCode(installed)) {
            throw new IOException("APK 包名或版本与更新不匹配");
        }
        Signature[] oldSigners = signers(installed);
        Signature[] newSigners = signers(candidate);
        if (oldSigners == null || oldSigners.length == 0 || newSigners == null
            || !new HashSet<>(Arrays.asList(oldSigners)).equals(new HashSet<>(Arrays.asList(newSigners)))) {
            throw new IOException("APK 签名与当前应用不一致");
        }
    }

    @SuppressWarnings("deprecation")
    private Signature[] signers(PackageInfo info) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return info.signatures;
        return info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners();
    }

    private void launch(PluginCall call, Intent intent, String callback) {
        try {
            startActivityForResult(call, intent, callback);
        } catch (ActivityNotFoundException | SecurityException error) {
            fail(call, "无法打开 Android 安装界面");
        }
    }

    @ActivityCallback
    private void installFinished(PluginCall call, ActivityResult result) {
        if (call == null) { installing.set(false); return; }
        if (result.getResultCode() != Activity.RESULT_OK) {
            fail(call, "安装未完成，可点击重试");
            return;
        }
        pendingApk().delete();
        installing.set(false);
        call.resolve();
    }

    private File pendingApk() {
        return new File(new File(getContext().getCacheDir(), "agentroam-update"), "update.apk");
    }

    private void fail(PluginCall call, String message) {
        pendingApk().delete();
        installing.set(false);
        call.reject(message);
    }

    private void publish(String phase, int progress, String message) {
        JSObject status = new JSObject().put("phase", phase).put("progress", progress);
        if (message != null) status.put("message", message);
        notifyListeners("progress", status);
    }
}
