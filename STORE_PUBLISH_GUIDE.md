# Publishing to App Store & Play Store

Your app uses **Capacitor** to wrap the Vercel-hosted PWA in native iOS and Android shells.

---

## Prerequisites

| | Google Play Store | Apple App Store |
|---|---|---|
| **Account** | [Google Play Console](https://play.google.com/console) — $25 one-time | [Apple Developer](https://developer.apple.com) — $99/year |
| **Build tool** | Android Studio | Xcode (Mac only) |
| **Signing** | Upload keystore (generated below) | Provisioning profile via Xcode |

---

## Step 1: Update Your Vercel URL

Edit `capacitor.config.ts` and replace the placeholder URL with your actual Vercel deployment:

```ts
server: {
  url: 'https://your-actual-app.vercel.app',  // <-- your real URL
  cleartext: false,
},
```

---

## Step 2: Generate App Icons

Place a 1024x1024 PNG icon at `assets/icon.png` (or use the included SVG), then run:

```bash
pnpm icons
```

This generates all required icon sizes for both platforms.

---

## Step 3: Sync Native Projects

After any config changes:

```bash
pnpm cap:sync
```

---

## Google Play Store (Android)

### Build the APK/AAB

```bash
# Open in Android Studio
pnpm cap:android

# OR build from command line
pnpm cap:build:android
```

### Create a signing key (first time only)

```bash
keytool -genkey -v -keystore staging-inventory.keystore \
  -alias staging-inventory -keyalg RSA -keysize 2048 -validity 10000
```

**SAVE THIS KEYSTORE FILE AND PASSWORD.** You cannot update your app without it.

### Sign the release build

In Android Studio:
1. **Build → Generate Signed Bundle / APK**
2. Choose **Android App Bundle (.aab)** — required for Play Store
3. Select your keystore file and enter credentials
4. Choose **release** build variant
5. The signed `.aab` file will be in `android/app/release/`

### Upload to Play Store

1. Go to [Google Play Console](https://play.google.com/console)
2. **Create app** → fill in app name, category (Business or Productivity), etc.
3. **Production → Create new release** → upload the `.aab` file
4. Fill in the store listing:
   - **App name:** Staging Inventory Manager
   - **Short description:** Track furniture inventory and manage property staging
   - **Full description:** (see below)
   - **Screenshots:** Take from your phone (min 2 screenshots)
   - **Feature graphic:** 1024x500 banner image
   - **Category:** Business or Productivity
   - **Content rating:** Complete the questionnaire (it's a business tool, all answers are "No")
5. **Review and publish** — usually approved within hours to a few days

---

## Apple App Store (iOS)

> **Requires a Mac with Xcode installed.**

### Open in Xcode

```bash
pnpm cap:ios
```

### Configure signing

1. In Xcode, select the **App** target
2. Go to **Signing & Capabilities**
3. Select your **Team** (your Apple Developer account)
4. Xcode will auto-create provisioning profiles

### Build and archive

1. Set the device to **Any iOS Device (arm64)**
2. **Product → Archive**
3. Once archived, click **Distribute App**
4. Choose **App Store Connect**
5. Follow the prompts to upload

### Submit on App Store Connect

1. Go to [App Store Connect](https://appstoreconnect.apple.com)
2. **My Apps → +** → New App
3. Fill in:
   - **App name:** Staging Inventory Manager
   - **Bundle ID:** com.stagingtools.inventory
   - **SKU:** staging-inventory-manager
   - **Screenshots:** Required for 6.7" (iPhone 15 Pro Max) and 12.9" (iPad Pro) at minimum
   - **Description:** (see below)
   - **Category:** Business or Productivity
   - **Privacy Policy URL:** Required — you'll need a simple privacy policy page
4. Select the uploaded build
5. **Submit for Review** — usually takes 1-3 days

### Important: Apple requires a Privacy Policy

Create a simple page at `https://your-app.vercel.app/privacy` that covers:
- What data you collect (email for auth, inventory data)
- Where it's stored (Supabase)
- No data is sold to third parties

---

## Suggested Store Description

```
Staging Inventory Manager — the all-in-one tool for home stagers and real estate professionals.

• Track furniture and decor inventory with photos, dimensions, and condition
• Manage multiple properties and storage units
• Move items between locations with full staging history
• AI-powered item identification and dimension measurement
• Find deals on furniture from multiple sources
• Financial tracking with tax reports and depreciation
• Works offline — syncs across all your devices in real-time
• Team collaboration with shared inventory

Whether you're staging one home or managing a full staging business, keep your entire inventory organized and accessible from any device.
```

---

## Updating the App

Since the app loads from your Vercel URL, most updates happen automatically — just deploy to Vercel and all users get the new version instantly.

You only need to rebuild and resubmit to the stores when you:
- Change the Capacitor config
- Add new native plugins
- Update the app icon or splash screen
- Need to bump the version number for store compliance

To bump version:
- **Android:** Edit `android/app/build.gradle` → `versionCode` and `versionName`
- **iOS:** Edit in Xcode → target → General → Version and Build

---

## Quick Reference

| Command | What it does |
|---|---|
| `pnpm cap:sync` | Sync web code + plugins to native projects |
| `pnpm cap:android` | Open Android project in Android Studio |
| `pnpm cap:ios` | Open iOS project in Xcode |
| `pnpm cap:build:android` | Build Android release APK |
| `pnpm icons` | Generate app icons from `assets/` |
