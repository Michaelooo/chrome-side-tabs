export interface AIGroupRequest {
  tabs: Array<{ index: number; title: string; url: string }>
}

export interface AIGroupResponse {
  groups: Array<{
    title: string
    color: string
    indices: number[]
  }>
}
