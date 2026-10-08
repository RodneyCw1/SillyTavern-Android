package io.sillytavern.standalone

import org.junit.Assert.*
import org.junit.Test
import java.io.File

class UpdatePolicyTest {
    private fun valid() = UpdateInfo("1.1.5+build.1", 1001, UpdatePolicy.PACKAGE, 29,
        "https://github.com/RodneyCw1/SillyTavern-Android/releases/download/v1.1.5%2Bbuild.1/app.apk",
        3, "0".repeat(64), UpdatePolicy.CERTIFICATE, "a".repeat(40), "Test")
    @Test fun acceptsOriginalSigningAndSupportedSdk() { UpdatePolicy.validate(valid(), 29); UpdatePolicy.requireUpgrade(valid(), 7) }
    @Test fun refusesInstallationWhileBackendIsBusyEvenAfterPageReload() {
        UpdatePolicy.requireIdle(true, false, 0, 0, 0)
        for (state in listOf(listOf(1,0,0), listOf(0,1,0), listOf(0,0,1), listOf(-1,0,0))) {
            assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.requireIdle(true,false,state[0],state[1],state[2]) }
        }
        assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.requireIdle(false,false,0,0,0) }
        assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.requireIdle(true,true,0,0,0) }
    }
    @Test fun refusesEqualAndOlderVersions() {
        for (code in listOf(1001L, 1002L)) assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.requireUpgrade(valid(), code) }
    }
    @Test fun refusesIncorrectPackageCertificateHashSizeAndSdk() {
        for (bad in listOf(valid().copy(packageName="other"), valid().copy(signingSha256="f".repeat(64)),
            valid().copy(sha256="invalid"), valid().copy(size=0), valid().copy(size=2147483649),
            valid().copy(minSdk=37), valid().copy(commit="main"))) {
            assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.validate(bad, 36) }
        }
    }
    @Test fun refusesUntrustedUrls() {
        for (url in listOf("http://github.com/RodneyCw1/SillyTavern-Android/releases/download/v1/a.apk",
            "https://github.com.evil.test/RodneyCw1/SillyTavern-Android/releases/download/v1/a.apk",
            "https://github.com/other/repo/releases/download/v1/a.apk",
            "https://user@github.com/RodneyCw1/SillyTavern-Android/releases/download/v1/a.apk",
            "https://github.com/RodneyCw1/SillyTavern-Android/releases/download/../a.apk")) {
            assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.validate(valid().copy(apkUrl=url),36) }
        }
    }
    @Test fun rejectsDamagedOrTruncatedDownload() {
        val file=File.createTempFile("update-test", ".apk")
        try {
            file.writeText("abc")
            val info=valid().copy(sha256=UpdatePolicy.sha256(file))
            UpdatePolicy.verifyFile(file,info)
            file.writeText("abd")
            assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.verifyFile(file,info) }
            file.writeText("ab")
            assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.verifyFile(file,info) }
        } finally { file.delete() }
    }
}
