import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.stagingtools.inventory',
  appName: 'Staging Inventory',
  webDir: 'public',
  server: {
    url: 'https://model-context-protocol-mcp-with-vercel-functions.vercel.app',
    cleartext: false,
  },
  ios: {
    backgroundColor: '#1e1b4b',
  },
  android: {
    backgroundColor: '#1e1b4b',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#1e1b4b',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#1e1b4b',
    },
  },
};

export default config;
