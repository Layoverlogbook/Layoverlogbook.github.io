package io.github.layoverlogbook;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * Layover Logbook for Android.
 * Shows the live app full screen, so crew always have the latest version.
 * The app caches itself and keeps working offline after the first visit.
 */
public class MainActivity extends Activity {

    private static final String[] SITES = {
            "https://layoverlogbook.github.io/app.html",
            "https://karawene112.github.io/layover/app.html"
    };
    private static final String[] OUR_HOSTS = {"layoverlogbook.github.io", "karawene112.github.io"};
    /* Payment and sign-in pages that must stay inside the app */
    private static final String[] INSIDE_HOSTS = {"paddle.com", "paddle.io", "supabase.co"};

    private static final int REQ_FILES = 1;
    private static final int REQ_LOCATION = 2;

    private WebView web;
    private int siteIndex = 0;
    private ValueCallback<Uri[]> fileCallback;
    private String geoOrigin;
    private GeolocationPermissions.Callback geoCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " LayoverLogbookAndroid/2");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (scheme.equals("file") || isInside(u.getHost())) return false;
                openOutside(u);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                siteIndex++;
                if (siteIndex < SITES.length) view.loadUrl(SITES[siteIndex]);
                else view.loadUrl("file:///android_asset/offline.html");
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQ_FILES);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "No app found to pick files", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocation()) {
                    callback.invoke(origin, true, false);
                } else {
                    geoOrigin = origin;
                    geoCallback = callback;
                    requestPermissions(new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
                }
            }
        });

        web.setDownloadListener((url, ua, disposition, mime, length) -> {
            if (url.startsWith("http")) openOutside(Uri.parse(url));
            else Toast.makeText(this, "Downloads work from the website in your browser", Toast.LENGTH_LONG).show();
        });

        if (saved != null) {
            web.restoreState(saved);
        } else {
            Uri link = getIntent() != null ? getIntent().getData() : null;
            web.loadUrl(link != null && isInside(link.getHost()) ? link.toString() : SITES[0]);
        }
    }

    private boolean isInside(String host) {
        if (host == null) return false;
        for (String h : OUR_HOSTS) if (host.equals(h)) return true;
        for (String h : INSIDE_HOSTS) if (host.equals(h) || host.endsWith("." + h)) return true;
        return false;
    }

    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException ignored) {
        }
    }

    private boolean hasLocation() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_LOCATION && geoCallback != null) {
            geoCallback.invoke(geoOrigin, hasLocation(), false);
            geoCallback = null;
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == REQ_FILES && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
            fileCallback = null;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Uri link = intent.getData();
        if (link != null && isInside(link.getHost())) web.loadUrl(link.toString());
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }
}
