// Ottoman Bey Restaurant — Service Worker
// Handles background push notifications so staff get alerted
// even when the browser tab is closed or in background.

const CACHE_NAME = 'ottoman-bey-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// Handle push notifications from the server
self.addEventListener('push', (event) => {
  let data = { title: '🗨️ Ottoman Bey', body: 'New message', tag: 'chat' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/img/logo.png',
      badge: '/img/logo.png',
      tag: data.tag || 'ottoman-bey',
      vibrate: [200, 100, 200],
      requireInteraction: false,
      data: { url: data.url || '/staff' }
    })
  );
});

// When notification is clicked — open or focus the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/staff';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// Listen for messages from the main page to show notifications
// This is used as a fallback when Socket.IO delivers the event
// but the tab is in background.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, body, tag } = event.data;
    self.registration.showNotification(title || '🗨️ Ottoman Bey', {
      body: body || 'New message',
      icon: '/img/logo.png',
      tag: tag || 'chat',
      vibrate: [200, 100, 200],
      data: { url: '/staff' }
    });
  }
});
