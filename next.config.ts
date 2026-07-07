import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Telegram WebView / Safari агрессивно кэшируют корневой HTML,
        // из-за чего клиент открывает старый бандл и висит на «Инициализация…»
        // даже после свежего деплоя. Отдаём HTML без кэша — статические
        // /_next/... остаются с иммутабельным заголовком по умолчанию.
        source: "/",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
