# T3 Code TV

An Apple TV client for T3 Code, built on react-native-tvos. It shares connection, relay, and
state code with `apps/mobile` through `@t3tools/client-runtime`. See
`docs/internals/apple-tv-client.md` for the design and open questions.

## Requirements

- Xcode with the tvOS SDK and an Apple TV simulator.
- `pnpm install` at the repository root.
- For T3 Connect: `cp .env.example .env` at the repository root. It holds the public Clerk and
  relay identifiers that official builds use. Without it the T3 Connect card says the build has
  no configuration, and pairing with host and code still works.
- `~/.netrc` must be mode 600 (`chmod 600 ~/.netrc`), or `pod install` fails during prebuild. To
  build without it, point `NETRC` at an empty path: `NETRC=/tmp/empty-netrc vp run ios:simulator`.

## Run on the simulator

```sh
cd apps/tv
vp run ios:simulator
```

This runs `expo prebuild --clean` for tvOS, builds, installs on a booted Apple TV simulator, and
starts Metro. Pass a simulator with `npx expo run:ios --device <udid>` after a prebuild; list
them with `xcrun simctl list devices available | grep -i "apple tv"`. In the simulator, the
arrow keys move focus and Return selects.

Dev-only flags, read at bundle time:

- `EXPO_PUBLIC_TV_DEV_PAIRING_URL=http://127.0.0.1:3773/pair#token=...` prefills the pairing form.
- `EXPO_PUBLIC_TV_DEV_AUTO_PAIR=1` submits it at launch.
- `EXPO_PUBLIC_TV_DEV_OPEN_ENVIRONMENT=1` opens the first environment that connects.

## Run on an Apple TV

Pair the Apple TV with Xcode once:

1. Put the Mac and the Apple TV on the same Wi-Fi network.
2. On the Apple TV, open Settings > Remotes and Devices > Remote App and Devices. Leave it open.
3. On the Mac, open Xcode > Window > Devices and Simulators. The Apple TV shows under
   Discovered. Select it, choose Pair, and enter the code the TV shows.

Then build with your own signing team. Set these in the repository-root `.env.local` (git
ignores it) or in the shell:

| Variable                   | Sets                                        | Default                 |
| -------------------------- | ------------------------------------------- | ----------------------- |
| `T3CODE_IOS_APPLE_TEAM_ID` | `ios.appleTeamId`                           | unset (Xcode asks)      |
| `T3CODE_IOS_BUNDLE_ID`     | `ios.bundleIdentifier`, with `.tv` appended | `com.t3tools.t3code.tv` |
| `T3CODE_TV_BUNDLE_ID`      | `ios.bundleIdentifier`, used as is          | the line above          |

`EXPO_TV=1 npx expo config` in `apps/tv` shows the values a build uses.

```sh
cd apps/tv
vp run ios:device           # debug build, loads JavaScript from Metro on this Mac
vp run ios:device:release   # release build with the bundle embedded, runs without Metro
```

Both prebuild first, then `expo run:ios --device` lists connected devices and asks which one to
use. The debug build needs the Mac running Metro on the same network. Use the release build to
keep the app on the TV after you close the terminal. A free Apple ID team signs builds for 7
days; a paid team signs for a year.

## What works today

- Pairing with a host and pairing code, typed with the Siri Remote or the iPhone keyboard.
- Signing in to T3 Connect with an email code. The account must already exist; sign up on the
  phone or the web first. The session is kept in the keychain and restored at launch.
- Listing the account's T3 Connect environments with their online or offline state, and adding
  one as a relay connection. Signing out removes relay environments from the TV.
- Each environment's projects and threads.

## What does not work

- Camera pairing: tvOS has no camera, so there is no QR code scanning. Type the host and code.
- OAuth and Sign in with Apple: tvOS has no browser or web view, so Clerk's OAuth strategies,
  Apple sign-in, and passkeys cannot run. Email code is the only sign-in.
- Dictation works only through the system keyboard's microphone (Siri Remote or the iPhone
  keyboard). The app has no voice input of its own.
