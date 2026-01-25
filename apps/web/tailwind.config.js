/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        'bg-subtle': '#141414',
        'bg-code': '#1a1a1a',
        text: '#fafafa',
        'text-muted': '#737373',
        accent: '#f97316',
        border: '#262626',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Monaco', 'Consolas', 'monospace'],
        sans: ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
