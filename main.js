const https = require('https');
const WebSocketClient = require('websocket').client;
const miakode = require('./miakode');

function getHome(homeID) {
  return new Promise((cb, err) => {
    https.get(`https://firestore.googleapis.com/v1/projects
/miakapp-3/databases/(default)/documents/homes/${homeID}`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('close', () => {
        data = JSON.parse(data);
        if (data.fields && data.fields.name) {
          cb({
            id: homeID,
            name: data.fields.name.stringValue,
            server: data.fields.server.stringValue,
          });
        } else err(new Error('Wrong homeID'));
      });
    });
  });
}

function parsePacket(packet) {
  if (!packet.binaryData) return { type: 'unknown' };

  const parsed = packet.binaryData.toString();
  return {
    type: parsed[0],
    data: parsed.substring(1),
  };
}

const connect = async (credentials, {
  onReady, onHomeUpdate, onUserLogin, onUserAction,
}) => {
  const homeDoc = await getHome(credentials.home);
  if (!homeDoc.server) throw new Error('There is no selected server for this home');

  const client = new WebSocketClient();
  function newSocket() {
    console.log('Connecting to', homeDoc.server);
    client.connect(`wss://${homeDoc.server}/${homeDoc.id}/`, null, '//coordinator.miakapp');
  }

  let socket = null;

  function sendPacket(type, data) {
    socket.sendBytes(Buffer.from(`${type}${data}`));
    console.log('sendPacket =>', type, data.length);
  }

  client.on('connect', (s) => {
    console.log('Coordinator connected');
    socket = s;

    s.on('message', (packet) => {
      const msg = parsePacket(packet);

      if (msg.type === '\x30') { // PING
        sendPacket('\x40', msg.data);
        return;
      }

      if (msg.type === '\x31') { // USERLIST
        const users = msg.data.split('\x00').filter((u) => u).map((u) => {
          const [id, displayName, groups] = u.split('\x01');

          return {
            id: id.substring(2),
            displayName,
            isAdmin: (id[0] === '1'),
            notifications: (id[1] === '1'),
            groups: groups.split('\x02').filter((g) => g),
          };
        });

        onHomeUpdate(users);
        return;
      }

      if (msg.type === '\x32') { // USER CONNECT
        const parsed = miakode.string.decode(msg.data);
        const userClient = parsed.substring(1).split('@');

        onUserLogin({
          type: ['DISCONNECT', 'CONNECT'][parsed[0]],
          connectionUID: userClient[0],
          user: userClient[1],
        });
        return;
      }

      if (msg.type === '\x33') { // USER ACTION
        const [user, type, id, name, value] = miakode.array.decode(msg.data);
        onUserAction({
          user,
          type: (type === '1') ? 'input' : 'click',
          input: { id, name, value },
        });
        return;
      }

      if (msg.type === '\x00') { // LOGGED
        onReady();
        return;
      }

      console.log('Unknown packet', msg);
    });

    sendPacket('\x04', miakode.array.encode([
      credentials.home,
      credentials.id,
      credentials.secret,
    ]));

    s.on('close', (code, desc) => {
      console.log('CLOSE', code, desc);
      if (code === 4005) return;
      setTimeout(newSocket, 200);
    });
  });

  client.on('connectFailed', () => {
    console.log('Coordinator failed connect');
    setTimeout(newSocket, 1000);
  });

  newSocket();

  return {
    emitCallback(data) {
      sendPacket('\x41', miakode.object.encode(data));
    },
    emitNotif(userID, title, body, tag, image) {
      sendPacket('\x41', miakode.array.encode([
        userID, title, body, tag, image,
      ]));
    },
    reconnect() {
      if (socket && socket.close) {
        socket.close();
      }
    },
  };
};

/**
 * User instance
 * @typedef {Object} User
 * @property {string} id ID of the user
 * @property {string} displayName Display name of the user
 * @property {boolean} isAdmin True if the user is admin of the home
 * @property {boolean} notifications True if the user has enabled notifications
 * @property {string[]} groups List of group names of the user
 */

/**
 * User login event data
 * @typedef {Object} UserLoginEvent
 * @property {User} user
 * @property {'CONNECT' | 'DISCONNECT'} type Event type
 * @property {number} connectionUID ID of connection
 */

/**
 * DOM input (or button) element in a Miakapp page
 * @typedef InputElement
 * @property {string} id ID of DOM element
 * @property {string} name Name of DOM element
 * @property {string} value Value of input element (if exists)
 */

/**
 * User action event data
 * @typedef {Object} UserActionEvent
 * @property {User} user User who interacted with an input
 * @property {'click' | 'input'} type Event type ('click' or 'input')
 * @property {InputElement} input Input the user interacted with
 */

/**
 * Instance of miakapp home
 * @typedef {Object} Home
 * @property {User[]} users List of users who have access to the home
 * @property {Object<string, string>} variables Dynamic variables to inject in your pages
 * @property {(modifs: {}) => void} commit Send data modifications to users
 * @property {(callback: () => void) => void} onReady Event that handles when API is ready
 * @property {(callback: (users: User[]) => void) => void
 * } onUpdate Event that handles when an update of home settings happens
 * @property {(callback: (event: UserLoginEvent) => void) => void
 * } onUserLogin Event that handles when an user connects or disconnects
 * @property {(callback: (action: UserActionEvent) => void) => void
 * } onUserAction Event that handles when an user interact with a page
 * @property {() => void} reconnect Restart connection to the server
 */

/**
 * Creates a home instance
 * @param {string} home Home ID (in your URL)
 * @param {string} id Coordinator ID (default is "main")
 * @param {string} secret Coordinator secret token
 * @returns {Home} Returns an instance of home
 */
module.exports = function Miakapi(home, id, secret) {
  /** @type {(() => void)[]} */
  const readyCallbacks = [];
  /** @type {((users: User[]) => void)[]} */
  const userlistUpdateCallbacks = [];
  /** @type {((event: UserLoginEvent) => void)[]} */
  const userLoginCallbacks = [];
  /** @type {((action: UserActionEvent) => void)[]} */
  const userActionCallbacks = [];

  const client = {
    emitCallback() { return false; },
    emitNotif() { return false; },
    reconnect() { return false; },
  };

  /** @type {Home} */
  const thisHome = {
    users: [],
    variables: {},

    commit(modifs = {}) {
      Object.assign(this.variables, modifs);
      client.emitCallback(this.variables);
    },

    sendNotif(notification = {}) {
      client.emitNotif(notification);
    },

    onReady(callback) {
      readyCallbacks.push(callback);
    },
    onUpdate(callback) {
      userlistUpdateCallbacks.push(callback);
    },
    onUserLogin(callback) {
      userLoginCallbacks.push(callback);
    },
    onUserAction(callback) {
      userActionCallbacks.push(callback);
    },

    reconnect() {
      client.reconnect();
    },
  };

  connect({ home, id, secret }, {
    onReady() {
      readyCallbacks.forEach((h) => h());
    },
    onHomeUpdate(data) {
      thisHome.users = data;
      userlistUpdateCallbacks.forEach((h) => h(thisHome.users));
    },
    onUserLogin(data) {
      const eventData = {
        ...data,
        user: thisHome.users.find((u) => u.id === data.user),
      };

      userLoginCallbacks.forEach((h) => h(eventData));
    },
    onUserAction(data) {
      const eventData = {
        ...data,
        user: thisHome.users.find((u) => u.id === data.user),
      };

      userActionCallbacks.forEach((h) => h(eventData));
    },
  }).then(({ emitCallback, emitNotif, reconnect }) => {
    client.emitCallback = emitCallback;
    client.emitNotif = emitNotif;
    client.reconnect = reconnect;
  });

  return thisHome;
};
