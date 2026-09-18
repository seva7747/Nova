/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#06070b",
          900: "#0b0d14",
          850: "#10131c",
          800: "#151827",
        },
        nova: {
          cyan: "#5eead4",
          blue: "#60a5fa",
          violet: "#a78bfa",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 60px -10px rgba(96,165,250,0.45)",
      },
    },
  },
  plugins: [],
};
