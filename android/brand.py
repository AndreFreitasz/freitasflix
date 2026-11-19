#!/usr/bin/env python3
"""
Turns a checkout of jellyfin-android into the Freitas+ app for Fire TV / Android TV.

jellyfin-android is a frame around the server's web interface, and the server serves
Freitas+, so the app shows Freitas+. This only changes what is around it:
  - name "Freitas+", own package id (installs next to the official Jellyfin apps)
  - Freitas+ icons and a TV banner
  - listed on the Fire TV / Android TV home screen (leanback launcher, no touchscreen)
  - videos play in Freitas+'s web player by default (its controls work with the remote)

Usage: brand.py <jellyfin-android dir> <freitasflix dir>
"""
import re
import shutil
import sys
from pathlib import Path

APP_ID = 'br.freitas.plus'
APP_NAME = 'Freitas+'


def edit(path: Path, fn):
    text = path.read_text(encoding='utf-8')
    new = fn(text)
    if new == text:
        sys.exit(f'brand.py: nothing changed in {path}, upstream layout changed?')
    path.write_text(new, encoding='utf-8')
    print('edited', path)


def main():
    app = Path(sys.argv[1])
    repo = Path(sys.argv[2])
    res = app / 'app/src/main/res'

    # icons + banner (adaptive icons would win over the PNGs on Android 8+)
    for f in (res / 'mipmap-anydpi-v26').glob('ic_launcher*.xml'):
        f.unlink()
    for src in (repo / 'android/res').rglob('*.png'):
        dst = res / src.relative_to(repo / 'android/res')
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        print('copied', dst)

    # name
    edit(res / 'values/strings_donottranslate.xml',
         lambda t: re.sub(r'(<string name="app_name(?:_short)?"[^>]*>)[^<]*(</string>)', rf'\g<1>{APP_NAME}\g<2>', t))

    # own package id
    edit(app / 'app/build.gradle.kts',
         lambda t: t.replace('    defaultConfig {\n', f'    defaultConfig {{\n        applicationId = "{APP_ID}"\n', 1))

    # TV launcher
    def manifest(t: str) -> str:
        t = t.replace(
            '    <application\n',
            '    <uses-feature android:name="android.software.leanback" android:required="false" />\n'
            '    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />\n\n'
            '    <application\n        android:banner="@drawable/freitas_banner"\n', 1)
        return t.replace(
            '<category android:name="android.intent.category.LAUNCHER" />',
            '<category android:name="android.intent.category.LAUNCHER" />\n'
            '                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />', 1)
    edit(app / 'app/src/main/AndroidManifest.xml', manifest)

    # play with the web player by default: Freitas+'s own player (remote-friendly controls, frame
    # preview, aim-then-seek). The integrated ExoPlayer's controls don't work with the Fire TV remote.
    # Only the default changes: whoever picks another player in the app settings keeps it.
    kotlin = app / 'app/src/main/java/org/jellyfin/mobile'
    edit(kotlin / 'app/AppPreferences.kt',
         lambda t: t.replace('getString(Constants.PREF_VIDEO_PLAYER_TYPE, VideoPlayerType.EXO_PLAYER)',
                             'getString(Constants.PREF_VIDEO_PLAYER_TYPE, VideoPlayerType.WEB_PLAYER)', 1))
    edit(kotlin / 'settings/SettingsFragment.kt',
         lambda t: t.replace('initialSelection = VideoPlayerType.EXO_PLAYER',
                             'initialSelection = VideoPlayerType.WEB_PLAYER', 1))


if __name__ == '__main__':
    main()
