/**
 * Environment / device context for segmentation. A single object, not a time series. Every field
 * is optional and independently degradable: UA-CH high-entropy values require an async request and
 * may be withheld; the Network Information API is Chromium-only. Absent != a default value.
 */
export interface EnvironmentStream {
  userAgent?: string;
  userAgentData?: UserAgentData;
  deviceMemory?: number;
  hardwareConcurrency?: number;
  connection?: NetworkInformation;
  // Viewport / screen geometry (CSS pixels), snapshot at capture time — needed to normalize CLS
  // (which is viewport-relative) and to judge whether the LCP element was above the fold.
  viewportWidth?: number;
  viewportHeight?: number;
  screenWidth?: number;
  screenHeight?: number;
  devicePixelRatio?: number;
  /** Whether JS self-profiling was available (and if not, why) at capture time. */
  selfProfiler?: 'available' | 'needs-document-policy' | 'unsupported';
}

export interface UserAgentBrand {
  brand: string;
  version: string;
}

export interface UserAgentData {
  brands?: UserAgentBrand[];
  mobile?: boolean;
  platform?: string;
  // High-entropy values (async getHighEntropyValues), present only when requested/granted.
  platformVersion?: string;
  architecture?: string;
  bitness?: string;
  model?: string;
  fullVersionList?: UserAgentBrand[];
  /** Device form factors, e.g. ['Desktop'] | ['Mobile'] | ['XR'] (high-entropy, array form). */
  formFactors?: string[];
}

export interface NetworkInformation {
  effectiveType?: string;
  rtt?: number;
  downlink?: number;
  saveData?: boolean;
}
