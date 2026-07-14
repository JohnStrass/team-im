/// <reference types="vite/client" />

import type { TeamImApi } from "../shared/contracts";

declare global {
  interface Window {
    teamIm: TeamImApi;
  }
}

export {};
