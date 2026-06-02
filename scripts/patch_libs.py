"""
PlatformIO extra_script: patches installed libraries before compilation.
Applies patches/adafruit_ads1x15.patch to the Adafruit ADS1X15 library.
Idempotent — checks for the patch marker before applying.
"""

Import("env")  # noqa: F821 — injected by PlatformIO SCons environment
import os


def _patch(path, marker, old, new):
    """Replace `old` with `new` in file at `path` unless `marker` already present."""
    with open(path, "r") as f:
        content = f.read()
    if marker in content:
        return
    if old not in content:
        print(f"patch_libs: WARNING — expected text not found in {os.path.basename(path)}, skipping")
        return
    with open(path, "w") as f:
        f.write(content.replace(old, new, 1))
    print(f"patch_libs: patched {os.path.basename(path)}")


lib_dir = os.path.join(
    env.subst("$PROJECT_LIBDEPS_DIR"),
    env.subst("$PIOENV"),
    "Adafruit ADS1X15",
)

if not os.path.isdir(lib_dir):
    print("patch_libs: Adafruit ADS1X15 not found, skipping (run `pio pkg install` first)")
else:
    _patch(
        path=os.path.join(lib_dir, "Adafruit_ADS1X15.h"),
        marker="configureDataReady",
        old="  bool conversionComplete();\n\nprivate:",
        new=(
            "  bool conversionComplete();\n\n"
            "  /** @brief Configure ALRT/RDY pin as conversion-ready output.\n"
            "   *         Call once after begin(), before attaching the RDY interrupt. */\n"
            "  void configureDataReady();\n\n"
            "private:"
        ),
    )

    _patch(
        path=os.path.join(lib_dir, "Adafruit_ADS1X15.cpp"),
        marker="configureDataReady",
        old=(
            "bool Adafruit_ADS1X15::conversionComplete() {\n"
            "  return (readRegister(ADS1X15_REG_POINTER_CONFIG) & 0x8000) != 0;\n"
            "}"
        ),
        new=(
            "bool Adafruit_ADS1X15::conversionComplete() {\n"
            "  return (readRegister(ADS1X15_REG_POINTER_CONFIG) & 0x8000) != 0;\n"
            "}\n\n"
            "void Adafruit_ADS1X15::configureDataReady() {\n"
            "  writeRegister(ADS1X15_REG_POINTER_LOWTHRESH, 0x0000);\n"
            "  writeRegister(ADS1X15_REG_POINTER_HITHRESH, 0x8000);\n"
            "}"
        ),
    )
