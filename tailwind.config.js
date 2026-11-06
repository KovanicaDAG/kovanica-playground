/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "#09090b",
        surface: "#121214",
        "surface-2": "#1a1a1e",
        border: "#2a2a30",
        gold: {
          DEFAULT: "#F2A900",
          hover: "#d99700",
          dark: "#c48a00",
          light: "#ffbf33",
        },
        fg: "#f2f1ee",
        muted: "#9a9aa3",
        subtle: "#6b6b74",
      },
      fontFamily: {
        sans: ["Inter", "IBM Plex Sans", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
