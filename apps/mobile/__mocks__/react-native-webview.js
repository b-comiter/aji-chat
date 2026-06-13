/**
 * Jest manual mock for react-native-webview. The real module calls
 * TurboModuleRegistry.getEnforcing('RNCWebViewModule') at import time, which
 * throws under jest-expo (no native binary). Components that import WebView
 * (FileViewer, HtmlThumbnail) only need it to be a renderable no-op in tests —
 * their behavior is exercised on-device, not here.
 *
 * Placed in the package-root __mocks__ folder so Jest uses it automatically for
 * this node_modules package (no jest.mock() call required).
 */
const React = require('react')

function WebView(props) {
  return React.createElement('WebView', props, props.children ?? null)
}

module.exports = { WebView, default: WebView }
