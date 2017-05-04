const HTTPS_PORT = 8080;

const TYPE_INITIAL_HANDSHAKE = 0;
const TYPE_SDP_CONNECTION = 1;
const TYPE_ICE_INFO = 2;
const TYPE_BITRATE_CHANGED_INFO = 3;
const TYPE_CHAT_MESSAGE = 4;

const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');

// SSL is required for the WebRTC connections for Chrome. We use a temporary self-signed certificate
// https://tokbox.com/blog/the-impact-of-googles-new-chrome-security-policy-on-webrtc/
const serverConfig = {
    key: fs.readFileSync('./key.pem'),
    cert: fs.readFileSync('./cert.pem'),
};

// Create a server for the client html page
var handleRequest = function(request, response) {
    if(request.url === '/') {
        response.writeHead(200, {'Content-Type': 'text/html'});
        response.end(fs.readFileSync('../client/login.html'));
    } else if(request.url === '/app.js') {
        response.writeHead(200, {'Content-Type': 'application/javascript'});
        response.end(fs.readFileSync('../client/app.js'));
    }else if(request.url === '/app') {
        response.writeHead(200, {'Content-Type': 'text/html'});
        response.end(fs.readFileSync('../client/index.html'));
    }
};

var httpsServer = https.createServer(serverConfig, handleRequest);
httpsServer.listen(HTTPS_PORT);

// Create a server for handling websocket calls
var wss = new WebSocket.Server({
    server: httpsServer,
    clientTracking: true,
});

wss.on('connection', function(ws) {
    ws.on('message', function(message) {
        var msg = JSON.parse(message);
        switch (msg.type) {
            case TYPE_INITIAL_HANDSHAKE:
            //clients[msg.id] = ws;
            console.log("New handshake from " + msg.id + " at " + msg.date);
            break;

            case TYPE_SDP_CONNECTION:
            wss.broadcast(message); //todo - sent to the correct client 
            break;

            case TYPE_ICE_INFO:
            wss.broadcast(message);
            break;

            case TYPE_BITRATE_CHANGED_INFO:
            wss.broadcast(message);
            break;

            case TYPE_CHAT_MESSAGE:
            wss.broadcast(message);
            break;
        }
    });

    ws.on('close', function(code) {
        //delete clients
        console.log("Connection closed by " + ws + " with code " + code);
    });
});

wss.broadcast = function(data) {
    this.clients.forEach(function(client) {
        if(client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
};

function onIncomingMessage(message) {
    var msg = JSON.parse(message);
    switch (msg.type) {
        case TYPE_INITIAL_HANDSHAKE:
        //clients[] = 
        console.log("New handshake from " + msg.id + " at " + msg.date);
        break;
    }
}

console.log('Server initialized and running on https://localhost:' + HTTPS_PORT);
