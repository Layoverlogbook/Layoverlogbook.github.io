plugins {
    id("com.android.application")
}

// Signing: a private key from GitHub secrets when set (needed for Google Play),
// otherwise the sideload key in this folder, so updates install over older versions.
val ksPath = System.getenv("ANDROID_KEYSTORE_FILE") ?: "../sideload.keystore"
val ksPass = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: "layover-sideload"
val ksAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "layover"
val ksKeyPass = System.getenv("ANDROID_KEY_PASSWORD") ?: ksPass
val build = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "io.github.layoverlogbook"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.layoverlogbook"
        minSdk = 24
        targetSdk = 35
        versionCode = build
        versionName = "2.0.$build"
    }

    signingConfigs {
        create("release") {
            storeFile = file(ksPath)
            storePassword = ksPass
            keyAlias = ksAlias
            keyPassword = ksKeyPass
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
