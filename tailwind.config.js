/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Dark theme: remap slate scale
        slate: {
          50: '#0c0c1d',
          100: '#141428',
          200: '#252545',
          300: '#2e2e50',
          400: '#64748b',
          500: '#94a3b8',
          600: '#cbd5e1',
          700: '#e2e8f0',
          800: '#f1f5f9',
          900: '#ffffff',
          950: '#ffffff',
        },
      },
    },
  },
  plugins: [],
}
