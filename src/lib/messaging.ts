import type { MessageRequest, MessageResponse } from '../types/messages'

export function sendMessage(msg: MessageRequest): Promise<MessageResponse> {
  return chrome.runtime.sendMessage(msg)
}

export function onMessage(handler: (msg: MessageRequest) => Promise<MessageResponse> | void): void {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const result = handler(msg as MessageRequest)
    if (result instanceof Promise) {
      result.then(sendResponse)
      return true // keep channel open for async
    }
  })
}
