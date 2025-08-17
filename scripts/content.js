if (window.parent === window) {
  const version = chrome.runtime.getManifest().version;

  const extensionElement = document.createElement('div');
  extensionElement.id = 'infyverse-extension-data';
  extensionElement.dataset.version = version;
  extensionElement.style.display = 'none';
  document.body.appendChild(extensionElement);

  window.dispatchEvent(
    new CustomEvent('infyverse-extension-present', {
      detail: { version },
      bubbles: true,
    })
  );
}

console.log('Content script loaded on trigger URL.', window.location.href)

if (window.parent !== window) {
  console.log(
    'Content script in iframe loaded on:',
    window.location.href,
    '. Sending "iframeContentLoaded" message to parent.'
  )
  window.parent.postMessage(
    { type: 'iframeContentLoaded', href: window.location.href, status: 'ready' },
    '*'
  )
  console.log('Adding message listener for parent communication on', window.location.href);
    window.addEventListener('message', async (event) => {
      if (event.source === window.parent && event.ports && event.ports[0]) {
        const port = event.ports[0];
        console.log('Message received from parent via MessageChannel:', event.data);

        try {
          let responseSent = false;
          const sendResponse = (data) => {
            if (!responseSent) {
              port.postMessage(data);
              responseSent = true;
            }
          };

          switch (event.data.message) {
            case 'getDOM':
              sendResponse({
                success: true,
                message: 'DOM',
                html: document.documentElement.outerHTML,
                href: window.location.href,
              });
              break;
            case 'scrollTo':
              if (event.data.selector === "bottom") {
                window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                sendResponse({ success: true, action: 'scrollTo' });
              } else {
                const scrollEl = document.querySelector(event.data.selector);
                if (scrollEl) {
                    scrollEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    sendResponse({ success: true, action: 'scrollTo' });
                } else {
                    sendResponse({ success: false, action: 'scrollTo', error: `Element not found: ${event.data.selector}` });
                }
              }
              break;
            case 'click':
              let clickEl
              if (event.data.selector) {
                clickEl = document.querySelector(event.data.selector);
              } else if (event.data.x && event.data.y) {
                clickEl = document.elementFromPoint(event.data.x, event.data.y);
              } 
              if (clickEl) {
                  clickEl.click();
                  sendResponse({ success: true, action: 'click' });
              } else {
                  sendResponse({ success: false, action: 'click', error: `Element not found: ${event.data.selector}` });
              }
              break;
            case 'textInput':
              const textToInput = event.data.text || '';
              let textInputEl
              if (event.data.selector) {
                textInputEl = document.querySelector(event.data.selector);
              } else if (event.data.x && event.data.y) {
                textInputEl = document.elementFromPoint(event.data.x, event.data.y);
              }

              if (!textInputEl) {
                sendResponse({ success: false, action: 'textInput', error: `Element not found`});
                break; 
              }

              try {
                textInputEl.focus();
                
                await new Promise(resolve => setTimeout(resolve, 100));                

                if (document.activeElement !== textInputEl) {
                  console.warn(`Initial focus failed. Input may not work as expected.`);
                }

                if (textInputEl.tagName === 'INPUT' || textInputEl.tagName === 'TEXTAREA') {
                  textInputEl.value = textToInput;
                } else {
                  const pasteEvent = new ClipboardEvent('paste', {
                    bubbles: true,
                    cancelable: true,
                    clipboardData: new DataTransfer()
                  });
                  pasteEvent.clipboardData.setData('text/plain', textToInput);
                  textInputEl.dispatchEvent(pasteEvent);
                }

                textInputEl.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
                sendResponse({ success: true, action: 'textInput' });
              } catch (e) {
                console.error(`Error during textInput`, e);
                sendResponse({ success: false, action: 'textInput', error: `Processing error: ${e.message}` });
              }
              break;
            case 'waitForElement':
              const { selector, timeout = 10000, pollInterval = 1000 } = event.data;
              let observer = null;
              let pollerId = null;

              const performCleanup = () => {
                if (observer) {
                  observer.disconnect();
                  observer = null;
                }
                if (pollerId) {
                  clearInterval(pollerId);
                  pollerId = null;
                }
              };

              const elementFoundPromise = new Promise((resolve) => {
                const el = document.querySelector(selector);
                if (el) {
                  resolve({ success: true, found: true, method: 'initial' });
                  return;
                }

                observer = new MutationObserver((mutations, obs) => {
                  const targetEl = document.querySelector(selector);
                  if (targetEl) {
                    resolve({ success: true, found: true, method: 'observer' });
                  }
                });
                observer.observe(document.documentElement, { childList: true, subtree: true });

                pollerId = setInterval(() => {
                  const targetEl = document.querySelector(selector);
                  if (targetEl) {
                    resolve({ success: true, found: true, method: 'polling' });
                  }
                }, pollInterval);
              });

              const timeoutPromise = new Promise((resolve) =>
                setTimeout(() => {
                  resolve({ success: false, found: false, error: `Timeout waiting for element: ${selector}` });
                }, timeout)
              );

              Promise.race([elementFoundPromise, timeoutPromise])
                .then(result => {
                  performCleanup();
                  sendResponse(result);
                })
                .catch(error => {
                  performCleanup();
                  sendResponse({
                    success: false,
                    error: `Unexpected error in waitForElement: ${error.message || String(error)}`
                  });
                });
              break;
            case 'replayRequest':
                (async () => {
                    try {
                        const messagePayload = {
                            action: 'getRequestForReplay',
                            url: event.data.url,
                            headers: event.data.headers,
                            href: window.location.href
                        };
                        const response = await new Promise((resolve, reject) => {
                            chrome.runtime.sendMessage(messagePayload, (response) => {
                                if (response && response.success) {
                                    resolve(response);
                                } else {
                                    reject(new Error(response ? response.error : "Failed to get request for replay."));
                                }
                            });
                        });

                        const result = await replayRequest(response.request, response.requestId);
                        sendResponse({ success: true, action: 'replayRequest', response: result });
                    } catch (error) {
                        sendResponse({ success: false, action: 'replayRequest', error: error.message });
                    }
                })();
                break;
            default:
              sendResponse({ success: false, error: `Unknown message type: ${event.data.message}` });
              break;
          }
        } catch (e) {
          console.error("Error processing message in iframe content script:", e);
          port.postMessage({ success: false, error: e.message, stack: e.stack });
        }
      } else if (event.source === window.parent) {
        console.warn("Received message from parent without a port (potential misconfiguration or old style):", event.data);
      }
  });
}

async function replayRequest(request, requestId) {
    console.log("Replaying request from content script:", request);
    let body;
    const headers = new Headers(request.headers);
    const originalContentType = headers.get('Content-Type');

    headers.delete('Content-Length');
    headers.delete('Host');

    if (request.formData) {
        if (originalContentType && originalContentType.includes('application/x-www-form-urlencoded')) {
            const params = new URLSearchParams();
            for (const key in request.formData) {
                if (Array.isArray(request.formData[key])) {
                    request.formData[key].forEach(value => params.append(key, value));
                }
            }
            body = params;
            headers.set('Content-Type', 'application/x-www-form-urlencoded');
        } else {
            body = new FormData();
            for (const key in request.formData) {
                if (Array.isArray(request.formData[key])) {
                    request.formData[key].forEach(value => body.append(key, value));
                }
            }
            headers.delete('Content-Type');
        }
    } else if (request.body) {
        try {
            const byteCharacters = atob(request.body);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            body = new Uint8Array(byteNumbers);
        } catch (e) {
            console.error("Error decoding base64 body:", e);
            throw new Error("Failed to decode request body.");
        }
    }

    try {
        const response = await fetch(request.url, {
            method: request.method,
            headers: headers,
            body: body,
        });
        console.log("Replayed request response status:", response.status);
        const text = await response.text();
        console.log("Replayed request response body:", text);
        const result = { status: response.status, text: text };
        chrome.runtime.sendMessage({ action: 'clearReplayedRequest', requestId: requestId, href: window.location.href });
        return result;
    } catch (error) {
        console.error("Error replaying request from content script:", error);
        chrome.runtime.sendMessage({ action: 'clearReplayedRequest', requestId: requestId, href: window.location.href });
        throw error;
    }
}
