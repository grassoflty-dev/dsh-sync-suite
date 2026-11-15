/**
 * 最小 `@ohos.*` / `@kit.*` 声明（仅类型，不参与编译产物）。
 *
 * 背景：`tools/tsconfig.json` 只编译模型层与 common 层（`model/**`、`common/**`），
 * 这两层**不 import 任何 @ohos 运行时**（契约硬要求）。本文件是给未来把 `services/`、
 * `pages/` 也纳入类型检查时用的最小桩：只声明实际用到的接口，不追求完整 SDK 形状。
 *
 * 用法（未来）：在独立 tsconfig 中加入 `"files": ["tools/stubs/ohos.d.ts"]` 或
 * `"include": ["tools/stubs/ohos.d.ts", ...]`。当前 tsconfig 未包含它。
 */

declare namespace ohosStub {
  interface Callback<T> {
    (err: unknown, data?: T): void;
  }
}

declare module '@kit.AbilityKit' {
  export interface AbilityConstantType {
    [key: string]: unknown;
  }

  export class UIAbility {
    context: {
      filesDir: string;
      cacheDir: string;
      preferencesDir?: string;
      resourceManager?: unknown;
    };
    onCreate(want: unknown, launchParam: unknown): void;
    onWindowStageCreate(windowStage: unknown): void;
    onForeground(): void;
    onBackground(): void;
    onDestroy(): void;
  }
}

declare module '@kit.CoreFileKit' {
  export interface FileHandle {
    fd: number;
    close(): Promise<void>;
    write(buffer: ArrayBuffer | string, options?: { offset?: number; length?: number }): Promise<number>;
    read(buffer: ArrayBuffer, options?: { offset?: number; length?: number }): Promise<number>;
  }

  interface FileIo {
    open(path: string, mode?: number): Promise<FileHandle>;
    close(file: FileHandle | number): Promise<void>;
    readText(path: string): Promise<string>;
    writeSync(fd: number, buffer: ArrayBuffer | string): number;
    stat(path: string): Promise<{ size: number; isDirectory(): boolean }>;
    access(path: string): Promise<boolean>;
    mkdir(path: string, recursion?: boolean): Promise<void>;
    unlink(path: string): Promise<void>;
    listFile(path: string): Promise<string[]>;
  }

  export const fileIo: FileIo;
}

declare module '@kit.NetworkKit' {
  export interface HttpRequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'OPTIONS';
    extraData?: string | ArrayBuffer;
    header?: Record<string, string>;
    expectDataType?: number;
    readTimeout?: number;
    connectTimeout?: number;
  }

  export interface HttpResponse {
    result: string | Object | ArrayBuffer;
    responseCode: number;
    header?: Record<string, string>;
  }

  export interface HttpRequest {
    request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
    destroy(): void;
  }

  export function createHttp(): HttpRequest;
}

declare module '@kit.ImageKit' {
  export interface ImageInfo {
    size: { width: number; height: number };
  }

  export interface PixelMap {
    getImageInfo(): Promise<ImageInfo>;
    release(): Promise<void>;
    readPixelsToBuffer(buffer: ArrayBuffer): Promise<void>;
  }

  export interface ImageSource {
    createPixelMap(options?: { desiredSize?: { width: number; height: number } }): Promise<PixelMap>;
    release(): Promise<void>;
  }

  export function createImageSource(buffer: ArrayBuffer): ImageSource;
}

declare module '@kit.BackgroundTasksKit' {
  export interface WantAgentInfo {
    pkgName: string;
    abilityName: string;
  }
}

declare module '@kit.ArkUI' {
  export function promptAction(options: { message: string; duration?: number }): void;
  export function getUIContext(): unknown;
}

declare module '@kit.ArkData' {
  export interface Preferences {
    get(key: string, defaultValue: unknown): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    flush(): Promise<void>;
  }

  export function getPreferences(context: unknown, name: string): Promise<Preferences>;
}

declare module '@ohos.util' {
  interface Base64Helper {
    encodeToStringSync(input: Uint8Array): string;
    decodeSync(input: string): Uint8Array;
  }

  export function createBase64(): Base64Helper;
}

declare module '@ohos.hilog' {
  export function debug(domain: number, tag: string, format: string, ...args: unknown[]): void;
  export function info(domain: number, tag: string, format: string, ...args: unknown[]): void;
  export function error(domain: number, tag: string, format: string, ...args: unknown[]): void;
}

declare module '@ohos.multimedia.image' {
  export interface PixelMap {
    release(): Promise<void>;
  }
}

/**
 * 设备信息（`entry/src/harmony/ets/common/devicePlatform.ets` 用它做运行时平台检测）。
 *
 * 只声明实际用到的两个字段：`osFullName`（主证据，如 `OpenHarmony 5.0.0`）与 `deviceType`
 * （兜底证据）。真实 SDK 里这两个字段都是 `string`，这里保持一致，便于类型检查直接读字段
 * （不用 `as Record<string, string>` 断言，以避免 ArkTS 严格模式的「类型不重叠」报错）。
 */
declare module '@ohos.deviceInfo' {
  interface DeviceInfo {
    osFullName: string;
    deviceType: string;
    [key: string]: string;
  }

  const deviceInfo: DeviceInfo;
  export default deviceInfo;
}
