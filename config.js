// Конфигурация хаба проектов и соцсетей lqsaf
// Чтобы добавить новый проект — просто добавь объект в массив PROJECTS ниже.
// По умолчанию:
//   logo -> ./logos/<id>logo.svg (с фолбэком на ./<id>logo.svg и авто-монограмму)
//   repo -> lqsaf/<id>
//   url  -> https://lqsaf.github.io/<id>/

export const CONFIG = {
  githubOwner: "lqsaf",

  // Опциональный URL Cloudflare Worker (см. папку ./worker).
  // Если пустая строка — браузерный Web Worker раз в час опрашивает GitHub API напрямую.
  workerUrl: "",

  // Порог «заброшенности»: 1 месяц (30 дней) без коммитов и слияний PR
  abandonedDaysThreshold: 30,

  // Строгий интервал автоматического обновления: 1 час (3 600 000 мс)
  syncIntervalMs: 60 * 60 * 1000,

  // Ссылка для кнопки «бесплатно поддержать» внизу сайта (пока пустая по ТЗ)
  supportUrl: "",
  supportLabel: "бесплатно поддержать",
};

export const PROJECTS = [
  {
    id: "fain",
    name: "fain",
    desc: "free ai news",
    url: "https://lqsaf.github.io/fain/",
    repo: "lqsaf/fain",
    logo: "./logos/fainlogo.svg",
  },
  {
    id: "fss",
    name: "fss",
    desc: "free self-study",
    url: "https://lqsaf.github.io/fss/",
    repo: "lqsaf/fss",
    logo: "./logos/fsslogo.svg",
  },
  {
    id: "ugr",
    name: "ugr",
    desc: "unical gamefication reality",
    url: "https://lqsaf.github.io/ugr/",
    repo: "lqsaf/ugr",
    logo: "./logos/ugrlogo.svg",
  },
  {
    id: "toyk",
    name: "toyk",
    desc: "transfer of your keys",
    url: "https://lqsaf.github.io/toyk/",
    repo: "lqsaf/toyk",
    logo: "./logos/toyklogo.svg",
  },
];

export const SOCIALS = [
  {
    id: "github",
    name: "github",
    desc: "@lqsaf",
    url: "https://github.com/lqsaf",
    logo: "./logos/github.svg",
  },
  {
    id: "tg",
    name: "tg",
    desc: "@lqsaf",
    url: "https://t.me/lqsaf",
    logo: "./logos/tg.svg",
  },
];
