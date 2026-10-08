plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "io.sillytavern.standalone"
    buildFeatures { buildConfig = true }
    compileSdk = 36
    ndkVersion = "28.2.13676358"
    defaultConfig {
        applicationId = "io.sillytavern.standalone"
        minSdk = 29
        targetSdk = 36
        versionCode = System.getenv("ST_ANDROID_VERSION_CODE")?.toInt() ?: 8
        versionName = System.getenv("ST_ANDROID_VERSION_NAME") ?: "1.1.5-dev"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        externalNativeBuild { cmake { arguments += "-DANDROID_STL=c++_shared" } }
    }
    signingConfigs {
        create("privateRelease") {
            val key = System.getenv("ST_ANDROID_KEYSTORE")
            if (key != null) {
                storeFile = file(key)
                storePassword = System.getenv("ST_ANDROID_STORE_PASSWORD")
                keyAlias = "sillytavern"
                keyPassword = System.getenv("ST_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("privateRelease") }
        debug { applicationIdSuffix = ".debug" }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }
    kotlinOptions { jvmTarget = "21" }
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt"); version = "3.22.1" } }
    sourceSets["main"].jniLibs.srcDir("src/main/jniLibs")
    packaging { jniLibs.useLegacyPackaging = false }
}
dependencies {
    testImplementation("junit:junit:4.13.2")
    implementation("androidx.activity:activity-ktx:1.12.2")
    implementation("androidx.webkit:webkit:1.15.0")
    implementation("androidx.core:core-ktx:1.17.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
