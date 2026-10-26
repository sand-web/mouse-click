/// <reference types="vite/client" />

interface Window {
  app: any;
  paletteBox: any;
  mouseClick?: {
    readonly initialRadius: number;
    getRadius(): Promise<ApertureRadiusState>;
    setRadius(value: unknown): Promise<ApertureRadiusState>;
    adjustRadius(delta: unknown): Promise<ApertureRadiusState>;
    onRadiusChanged(callback: (state: ApertureRadiusState) => void): () => void;
    showHighlight(): Promise<void>;
    hideHighlight(): Promise<void>;
  };
}

interface ApertureRadiusState {
  radius: number;
  saved: boolean | null;
  error: string | null;
  revision: number;
}
