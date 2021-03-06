var mysql = require('mysql'),
    sanitize = require('validator').sanitize,
    config = require('./config.js'),
    io = require('socket.io').listen(config.port);

var connection = {
    user: config.mysql.username,
    database: config.mysql.database,
    password: config.mysql.password
};
if (config.mysql.hasOwnProperty('socketPath')) {
    connection.socketPath = config.mysql.socketPath;
} else {
    connection.host = config.mysql.server;
}

mysqlConnection = mysql.createConnection(connection);

io.set('log level', 1);

String.prototype.markdown2html = function () {
    var text = this;
    // Bold
    text = text.replace(/(\*\*)(?=\S)([^\r]*?\S[*_]*)\1/g, "<strong>$2</strong>");
    // Italics
    text = text.replace(/(\*)(?=\S)([^\r]*?\S)\1/g, "<em>$2</em>");
    // Auto-detect links and convert them to markdown
    text = text.replace(/(\]\()?((https?|ftp|dict):[^'">\s]+)/gi, function ($0, $1, $2) {
        return $1 ? $0 : "[" + $2 + "](" + $2 + ")"
    });
    // Inline Links
    text = text.replace(/(\[((?:\[[^\]]*\]|[^\[\]])*)\]\([ \t]*()<?(.*?(?:\(.*?\).*?)?)>?[ \t]*((['"])(.*?)\6[ \t]*)?\))/g, '<a href="$4" target="_blank">$2</a>');
    return text;
};


var channelTests = [
    ['announcements', 0],
    ['public', 0],
    ['anime', 0],
    ['games', 0],
    ['worldnews', 0],
    ['recruit', 1],
    ['private', 2],
    ['corporal', 500],
    ['council', 1000]
];

var rooms = [];

for (var i in channelTests) {
    rooms.push(channelTests[i][0]);
}

// Map of users that can talk in #announcements (minus Corporal+)
var announcementsPrivileged = {};

var messageLog = {};

var socketVariables = {};

/** chatViewers[chatroom][user] = true **/
var chatViewers = {};

function populateTheMessageLog() {
    for (var i in rooms) {
        var room = rooms[i];
        mysqlConnection.query('SELECT `chatroom`,`timestamp`,`message`,`user`.`username` AS `user` FROM `chatMessage` LEFT JOIN `user` ON(`user`.`id`=`chatMessage`.`user_id`) WHERE chatroom = ? ORDER BY chatMessage.timestamp DESC, chatMessage.id DESC LIMIT 35', [room], function (err, rows) {
            if (err) {
                console.error(err);
            }
            var tempLog = [];
            for (var j in rows) {
                var row = rows[j];
                var message = sanitize(row.message).escape().markdown2html();
                tempLog.unshift({message: message, user: row.user, time: row.timestamp.getTime(), room: row.chatroom});
            }
            for (var j in tempLog) {
                addToMessageLog(tempLog[j], tempLog[j].room);
            }
            if (i == rooms.length - 1) {
                emitMessageLogTo(io.sockets);
            }
        });
    }
}

function addToMessageLog(message, room) {
    if (messageLog[room] == undefined) {
        messageLog[room] = [];
    }
    if (messageLog[room].length >= 35) {
        messageLog[room].shift();
    }
    messageLog[room].push(message);
}

function emitMessageLogTo(to, rooms) {
    var tempLog = [];
    for (var i in rooms) {
        var messageLogRoom = messageLog[rooms[i]];
        for (var j in messageLogRoom) {
            tempLog.push(messageLogRoom[j]);
        }
    }
    to.emit('messages', tempLog);
}

function emitRoomViewersTo(to, rooms) {
    var message = {};
    for (var roomI in rooms) {
        var room = rooms[roomI];
        message[room] = [];
        var clients = io.sockets.clients(room);
        var checked = {};
        for (var clientI in clients) {
            var client = clients[clientI];
            var info = socketVariables[client.id];
            if (info.username != undefined && !checked[info.username]) {
                message[room].push(info.username);
                checked[info.username] = true;
            }
        }
    }
    to.emit('members', message);
}

function mysqlStoreMessage(data) {
    var room = data.room;
    var user = data.userId;
    var message = data.message;
    var timestamp = data.timestamp / 1000;
    mysqlConnection.query("INSERT INTO chatMessage (`user_id`,`chatroom`,`message`,`timestamp`) VALUES (?, ?, ?, FROM_UNIXTIME(?))", [user, room, message, timestamp], function (err, result) {
        if (err) {
            console.error(err);
            mysqlStoreMessage(data);
        }
    });
}

function updatePrivileges(socket) {
    var info = socketVariables[socket.id];
    mysqlConnection.query('SELECT rank, username, banned FROM user WHERE id=?', [info.userId], function (err, rows) {
        if (err) {
            console.error(err);
        }
        if (!socketVariables[socket.id]) {
            return;
        }
        if (rows.length < 1) {
            socketVariables[socket.id].rank = 0;
        } else {
            var row = rows[0];
            socketVariables[socket.id].rank = row.rank;
            var channelMap = {};
            for (var i in info.channels) {
                channelMap[info.channels[i]] = true;
            }
            if (row.banned) {
                row.rank = -1;
            }

            var activateChannels = [];
            var deactivateChannels = [];
            var channels = [];
            var forcedJoin = 'public';
            for (var i in channelTests) {
                var channelName = channelTests[i][0];
                var rankTest = channelTests[i][1];
                if (channelMap[channelName] && row.rank < rankTest) {
                    deactivateChannels.push(channelName);
                    userLeave(socket, channelName);
                } else if (!channelMap[channelName] && row.rank >= rankTest) {
                    channels.push(channelName);
                    userJoin(socket, channelName);
                    activateChannels.push(channelName);
                }
                if (row.rank >= rankTest) {
                    channels.push(channelName);
                    if (channelName == 'public' || channelName == 'recruit' || channelName == 'private') {
                        forcedJoin = channelName;
                    }
                }
            }
            socketVariables[socket.id].channels = channels;
            if (activateChannels.length) {
                socket.emit('activateChannels', activateChannels);
            }
            if (deactivateChannels.length) {
                socket.emit('deactivateChannels', deactivateChannels);
            }
            socket.emit('defaultChannel', forcedJoin);
        }
    });
}

function userJoin(socket, room) {
    socket.join(room);
    var info = socketVariables[socket.id];
    if (!info.username) {
        return;
    }
    if (!chatViewers.hasOwnProperty(room)) {
        chatViewers[room] = {};
    }
    if (chatViewers[room].hasOwnProperty(info.username) && chatViewers[room][info.username] > 0) {
        chatViewers[room][info.username]++;
    } else {
        io.sockets.in(room).emit('join', [room, info.username]);
        chatViewers[room][info.username] = 1;
    }
}

function userLeave(socket, room) {
    socket.leave(room);
    var info = socketVariables[socket.id];
    if (!info.username) {
        return;
    }
    if (!chatViewers.hasOwnProperty(room)) {
        chatViewers[room] = {};
    }
    if (chatViewers[room].hasOwnProperty(info.username)) {
        chatViewers[room][info.username]--;
        if (chatViewers[room][info.username] < 1) {
            io.sockets.in(room).emit('leave', [room, info.username]);
            delete chatViewers[room][info.username];
        }
    }
}

populateTheMessageLog();
io.sockets.on('connection', function (socket) {
    var i;
    socketVariables[socket.id] = {};
    var publicChannels = [];
    for (i in channelTests) {
        var channelInfo = channelTests[i];
        if (channelInfo[1] === 0) {
            publicChannels.push(channelInfo[0]);
        }
    }
    emitMessageLogTo(socket, publicChannels);
    emitRoomViewersTo(socket, publicChannels);
    for (i in publicChannels) {
        socket.join(publicChannels[i]);
    }
    socket.on('token', function (data) {
        mysqlConnection.query("SELECT user.username AS username, user.rank AS rank, user.id AS userId FROM chatToken LEFT JOIN user ON(chatToken.user_id=user.id) WHERE chatToken.token LIKE ? AND chatToken.expires > CURRENT_TIMESTAMP", [data], function (err, rows) {
            mysqlConnection.query("DELETE FROM `chatToken` WHERE `token` = ? OR `expires` < CURRENT_TIMESTAMP", [data], function (err, result) {
                if (err) {
                    console.error(err);
                }
            });
            if (err) {
                console.error(err);
            }
            var row = {};
            if (!rows.length) {
                console.error('Bad Token ', data);
                row.rank = 0;
            } else {
                row = rows[0];
            }

            if (!socketVariables[socket.id]) {
                socketVariables[socket.id] = {};
            }
            socketVariables[socket.id].rank = row.rank;
            if (rows.length) {
                socketVariables[socket.id].username = row.username;
                socketVariables[socket.id].userId = row.userId;
            }
            // Subscribe to Channels
            var defaultChannel = 'public';
            if (row.rank >= 0) { // not banned
                var channels = ['public', 'announcements', 'anime', 'games', 'worldnews'];
                userJoin(socket, 'public');
                userJoin(socket, 'anime');
                userJoin(socket, 'games');
                userJoin(socket, 'worldnews');
                userJoin(socket, 'announcements');
            }
            if (row.rank >= 1) { // recruit+
                channels.push('recruit');
                userJoin(socket, 'recruit');
                defaultChannel = 'recruit';
            }
            if (row.rank >= 2) { // private+
                channels.push('private');
                userJoin(socket, 'private');
                defaultChannel = 'private';
            }
            if (row.rank >= 500) { // corporal+
                channels.push('corporal');
                userJoin(socket, 'corporal');
            }
            if (row.rank >= 1000) { // lieutenant+
                channels.push('council');
                userJoin(socket, 'council');
            }
            socketVariables[socket.id].channels = channels;
            emitMessageLogTo(socket, channels);
            socket.emit('verified');
            socket.emit('defaultChannel', defaultChannel);
            emitRoomViewersTo(socket, channels);
        });
    });
    socket.on('disconnect', function (data) {
        // tell the rooms the user was in that they are no longer there
        var rooms = io.sockets.manager.roomClients[socket.id];
        for (var room in rooms) {
            var isRoom = room.substr(0, 1) == '/';
            var room = room.substr(1);
            if (isRoom) {
                userLeave(socket, room);
            }
        }
        delete socketVariables[socket.id];
    });
    socket.on('message', function (data) {
        var info = socketVariables[socket.id];
        var tokens = data.message.split(' ');
        if (!info.username || !data.room || !data.message) {
            return;
        }
        // Special stuff for #announcements
        if ((info.username == 'Navarr') && data.message.substr(0, 11) == '/interview ' && tokens[1]) {
            announcementsPrivileged[tokens[1].toLowerCase()] = true;
            socket.emit('messages', [{
                room: 'announcements',
                user: 'System',
                time: (new Date).getTime(),
                message: tokens[1] + ' can now speak in #announcements'
            }]);
            return;
        }
        if ((info.username == 'Navarr') && data.message.substr(0, 7) == '/eject ' && tokens[1]) {
            delete announcementsPrivileged[tokens[1].toLowerCase()];
            socket.emit('messages', [{
                room: 'announcements',
                user: 'System',
                time: (new Date).getTime(),
                message: tokens[1] + ' can no longer speak in #announcements'
            }]);
            return;
        }

        // Check Room Privileges
        var room = data.room.toLowerCase();
        if ((room == 'recruit' && info.rank < 1) ||
            (room == 'private' && info.rank < 2) ||
            (room == 'corporal' && info.rank < 500) ||
            (room == 'council' && info.rank < 1000) ||
            (room == 'announcements' && info.rank < 500 && !announcementsPrivileged.hasOwnProperty(info.username.toLowerCase()))
        ) {
            socket.emit('messages', [{
                room: data.room,
                user: 'System',
                time: (new Date).getTime(),
                message: 'You do not have permission to speak in this room.'
            }]);
            return;
        }
        var htmlMessage = sanitize(data.message).escape().markdown2html();

        data.timestamp = Math.floor((new Date).getTime() / 1000) * 1000;
        var message = {
            room: data.room,
            user: socketVariables[socket.id].username,
            time: data.timestamp,
            message: htmlMessage
        };
        data.userId = info.userId;
        mysqlStoreMessage(data);
        updatePrivileges(socket);
        addToMessageLog(message, data.room);
        io.sockets.in(data.room).emit('messages', [message]);
    });
});
