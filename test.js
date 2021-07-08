const Miakapi = require('./main');
const credentials = require('./miakapiCredentials.json');

const home = Miakapi(
  credentials.home,
  credentials.coordID,
  credentials.coordSecret,
);

console.log('Connecting...');

home.onReady(() => {
  console.log('Ready !', home);
  home.users.forEach((user) => {
    console.log('Sending notification to', user.displayName);

    user.sendPush({
      title: 'Notification test 1',
      body: 'Test user.sendPush',
      tag: 'test1',
    });

    home.sendNotif(user.id, {
      title: 'Notification test 2',
      body: 'Test home.sendNotif',
      tag: 'test2',
    });
  });
});

home.onUpdate((users) => {
  console.log('Home update !', users);
});

home.onUserAction((action) => {
  console.log('User action :', action);
});

setInterval(() => {
  home.variables.timestamp = Date.now();
  home.commit({
    'global.timestamp': Date.now(),
    'global.invert': !home.variables['global.invert'],
  });
}, 5000);
