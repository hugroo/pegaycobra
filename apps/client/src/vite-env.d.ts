/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL del server de Colyseus. Default: ws://<host actual>:2567 */
  readonly VITE_SERVER_URL?: string;
}
