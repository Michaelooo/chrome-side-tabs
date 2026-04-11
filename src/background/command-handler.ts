import { logger } from '../lib/logger'

export function initCommandHandler() {
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'toggle-command-palette') {
      // Forward to all sidepanels via messaging
      chrome.runtime.sendMessage({ type: 'toggleCommandPalette' }).catch(() => {
        // No listeners, sidepanel might not be open
      })
      logger.info('Command palette toggle triggered')
    }
  })
  logger.info('Command handler initialized')
}
