import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.stagingtools.inventory',
  appName: 'Staging Inventory Manager',
  webDir: 'public',

  // Load the live Vercel-deployed app instead of bundled files.
  // Replace this URL with your actual Vercel deployment URL.
  server: {
    url: 'https://staging-inventory.vercel.app',
    cleartext: false,
  },

  ios: {
    scheme: 'Staging Inventory Manager',
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    backgroundColor: '#1e1b4b',
  },

  android: {
    backgroundColor: '#1e1b4b',
    allowMixedContent: false,
    useLegacyBridge: false,
  },

  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1500,
      backgroundColor: '#1e1b4b',
      showSpinner: false,
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#1e1b4b',
    },
  },
};

export default config;
