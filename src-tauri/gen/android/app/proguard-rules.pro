# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# ---------------------------------------------------------------------------
# Line connect (连线自动走棋)
# ---------------------------------------------------------------------------
# Classes referenced from AndroidManifest.xml are kept automatically, but the
# JavaScript bridge must keep every method reachable from the webview.
-keepclassmembers class com.jieqibox.lineconnect.LineConnectBridge {
    public *;
}
-keepclassmembers class com.jieqibox.lineconnect.MainActivity$SafFileInterface {
    public *;
}
-keepclassmembers class com.jieqibox.lineconnect.MainActivity$ExternalUrlInterface {
    public *;
}
-keep class com.jieqibox.lineconnect.ScreenCaptureService { *; }
-keep class com.jieqibox.lineconnect.AutoPlayAccessibilityService { *; }
