const path = require('path');

/** @type {import('expo/config').ConfigContext} */
module.exports = ({ config }) => ({
  ...config,
  icon: path.resolve(__dirname, 'assets/images/aji-logo.png'),
  android: {
    ...config.android,
    adaptiveIcon: {
      ...config.android?.adaptiveIcon,
      foregroundImage: path.resolve(__dirname, 'assets/images/adaptive-icon.png'),
    },
  },
  web: {
    ...config.web,
    favicon: path.resolve(__dirname, 'assets/images/favicon.png'),
  },
  plugins: config.plugins?.map(plugin => {
    if (Array.isArray(plugin) && plugin[0] === 'expo-splash-screen') {
      return [plugin[0], {
        ...plugin[1],
        image: path.resolve(__dirname, 'assets/images/splash-icon.png'),
      }];
    }
    return plugin;
  }),
});
