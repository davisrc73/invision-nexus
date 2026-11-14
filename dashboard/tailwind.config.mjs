/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        fnac: {
          DEFAULT: '#E1A924',
          dark: '#B68515',
          bg: '#0E0F12',
        },
        darty: {
          DEFAULT: '#E30613',
          dark: '#B5040F',
          bg: '#13151A',
        },
      },
    },
  },
  plugins: [],
};

