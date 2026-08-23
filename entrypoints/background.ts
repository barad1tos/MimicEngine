import { routePlanDiagnostics } from '../src/core/engine/diagnostics';
import { routeStyleCache } from '../src/core/storage/stylesheetCache';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (routeStyleCache(message, sendResponse)) return true;
    return routePlanDiagnostics(message, sendResponse);
  });
});
