/** BridgeClip approval policy defaults, independent of provider confidence. */
export const JEV_DEFAULTS = {
  jevThreshold: '0.75',
  jevSelfContainedThreshold: '0.70',
  jevFaithfulToSourceThreshold: '0.65',
  jevTitleSupportedThreshold: '0.70',
  jevSponsorThreshold: '0.80',
  jevEvidenceThreshold: '0.50',
  jevCutThreshold: '0.95',
} as const

export type JevThresholdKey = keyof typeof JEV_DEFAULTS
export type JevThresholdSettings = Record<JevThresholdKey, string>
export const JEV_DOCS_URL = 'https://docs.typesafe.ai/introduction'
export const JEV_CONFIDENCE_URL = 'https://docs.typesafe.ai/confidence'
