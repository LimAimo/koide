plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.diffusion.ide.nativeui"
    compileSdk = 36
    defaultConfig { minSdk = 24; consumerProguardFiles("consumer-rules.pro") }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_1_8; targetCompatibility = JavaVersion.VERSION_1_8 }
    kotlinOptions { jvmTarget = "1.8" }
    buildFeatures { compose = true }
    composeOptions { kotlinCompilerExtensionVersion = "1.5.15" }
}

configurations.configureEach {
    resolutionStrategy {
        // Tauri's generated Android graph may contribute an older Compose runtime.
        // Force one binary-compatible Compose generation for this plugin so the
        // Kotlin 1.9.25 / Compose Compiler 1.5.15 inline ABI stays coherent.
        force(
            "androidx.compose.runtime:runtime:1.7.0",
            "androidx.compose.runtime:runtime-saveable:1.7.0",
            "androidx.compose.ui:ui:1.7.0",
            "androidx.compose.ui:ui-unit:1.7.0",
            "androidx.compose.ui:ui-geometry:1.7.0",
            "androidx.compose.ui:ui-graphics:1.7.0",
            "androidx.compose.ui:ui-text:1.7.0",
            "androidx.compose.foundation:foundation:1.7.0",
            "androidx.compose.foundation:foundation-layout:1.7.0",
            "androidx.compose.animation:animation:1.7.0",
            "androidx.compose.animation:animation-core:1.7.0",
            "androidx.compose.material3:material3:1.3.0"
        )
    }
}

dependencies {
    implementation(project(":tauri-android"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.compose.runtime:runtime:1.7.0")
    implementation("androidx.compose.ui:ui:1.7.0")
    implementation("androidx.compose.ui:ui-tooling-preview:1.7.0")
    implementation("androidx.compose.foundation:foundation:1.7.0")
    implementation("androidx.compose.material3:material3:1.3.0")
}
