const cors = require("cors")
const express = require("express")
const app = express()
const server = require("http").createServer(app)

const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: [
            "*",
            // "http://localhost:3000",
        ],
        methods: ["GET", "POST"],
        transports: ['websocket', 'polling'],
        // credentials: true
    },
    allowEIO3: true,
    allowEIO4: true,
})

// const socketio = require("socket.io")(server, {
//     cors: {
//         origin: [
//             "http://localhost:3000",
//         ],
//         methods: ["GET", "POST"],
//         transports: ['websocket'],
//         credentials: true
//     },
//     allowEIO3: true,
//     allowEIO4: true,
// })

let wrtc = undefined
if (process.platform === "darwin" && process.arch === "arm64") {
    console.log("running on @koush/wrtc")
    wrtc = require("@koush/wrtc") // macOS + arm64
} else {
    console.log("running on wrtc")
    wrtc = require("wrtc")
}

// const server = http.createServer(app);

// const whitelist = new Set([
//     'http://localhost:3000/',
//     'https://localhost:3000/',
//     'http://localhost:8080/',
//     'https://localhost:8080/',
// ])

// const corsOptions = {
//     origin: function (origin, callback) {
//         if (!origin || whitelist.has(origin)) {
//             callback(undefined, true);
//         } else {
//             callback(new Error('Not allowed by CORS!'));
//         }
//     },
//     methods: ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS'],
//     optionsSuccessStatus: 200,
//     credentials: true,
//     allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'device-remember-token', 'Access-Control-Allow-Origin', 'Origin', 'Accept']
// }

app.use(cors());
// app.enable('trust proxy')

let receiverPCs = {}
let senderPCs = {}
let users = {}
let socketToRoom = {}
// let socketIDMap = {}

const pc_config = {
    iceServers: [
        {
            urls: [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302",
                "stun:stun2.l.google.com:19302",
                "stun:stun3.l.google.com:19302",
                "stun:stun4.l.google.com:19302",
              ],
        }
    ]
}

const isIncluded = (array, id) => array.some((item) => item.id === id)

const createReceiverPeerConnection = async (socketID, socket, roomID) => {
    const pc = await new wrtc.RTCPeerConnection(pc_config)

    pc.onicecandidate = async (e) => {
        console.log(`socketID: ${socketID}'s receiverPeerConnection icecandidate`)
        await socket.to(socketID).emit("getSenderCandidate", {
            candidate: e.candidate
        })
        // console.log("emitted getSenderCandidate", socketID)
    }

    pc.oniceconnectionstatechange = (e) => {
        console.log("ReceiverPeerConnection IceConnectionStateChange", socketID)
    }

    pc.ontrack = async (e) => {
        if (users[roomID]) {
            if (!isIncluded(users[roomID], socketID)) {
                await users[roomID].push({
                    id: socketID,
                    stream: e.streams[0],
                })
            } else return
        } else {
            users[roomID] = [
                {
                    id: socketID,
                    stream: e.streams[0],
                }
            ]
        }

        await socket.broadcast.to(roomID).emit("userEnter", { id: socketID })
        // console.log("emitted userEnter", socketID)
    }

    receiverPCs[socketID] = pc
    // socketIDMap[socket.id] = socketID

    return pc
}

const createSenderPeerConnection = async (
    receiverSocketID,
    senderSocketID,
    socket,
    roomID
) => {
    console.log("createSenderPeerConnection", senderSocketID, receiverSocketID)
    const pc = await new wrtc.RTCPeerConnection(pc_config)

    if (senderPCs[senderSocketID]) {
        // senderPCs[senderSocketID].filter((user) => user.id !== receiverSocketID)
        await senderPCs[senderSocketID].push({ id: receiverSocketID, pc })
    } else {
        senderPCs = await {
            ...senderPCs,
            [senderSocketID]: [{ id: receiverSocketID, pc }],
        }
    }
    // console.log("senderPC saved")

    pc.onicecandidate = async (e) => {
        console.log(`socketID: (${receiverSocketID})'s senderPeerConnection icecandidate`)
        await socket.to(receiverSocketID).emit("getReceiverCandidate", {
            id: senderSocketID,
            candidate: e.candidate,
        })
        // console.log("emitted getReceiverCandidate", senderSocketID, receiverSocketID)
    }

    pc.oniceconnectionstatechange = (e) => {
        console.log("SenderPeerConnection IceConnectionStateChange", receiverSocketID, senderSocketID)
    }

    const sendUser = await users[roomID].filter((user) => user.id === senderSocketID)[0]
    await sendUser.stream.getTracks().forEach(async (track) => {
        await pc.addTrack(track, sendUser.stream)
    })

    return pc
}

const getOtherUsersInRoom = async (socketID, roomID) => {

    let allUsers = []

    if (!users[roomID]) return allUsers

    allUsers = await users[roomID]
        .filter((user) => user.id !== socketID)
        .map((otherUser) => ({ id: otherUser.id }))

    // console.log('getOtherUsersInRoom', socketID, allUsers)
    return allUsers
}

const deleteUser = async (socketID, roomID) => {
    console.log("deleteUser", socketID, roomID)

    if (!users[roomID]) return
    
    users[roomID] = await users[roomID].filter((user) => user.id !== socketID)
    if(users[roomID].length === 0) {
        await delete users[roomID]
    }
    await delete socketToRoom[roomID]
}

const closeReceiverPC = async (socketID) => {
    console.log("closeReceiverPC", socketID)

    if (!receiverPCs[socketID]) return

    // console.log("closeReceiverPC", receiverPCs[socketID])

    // receiverPCs[socketID].close()
    // ?? doesn't continue 
    // 1. already closed in closed client? -> nothing to close (no ack)

    await delete receiverPCs[socketID]
    // console.log("closeReceiverPCs deleted")
}

const closeSenderPCs = async (socketID) => {
    console.log("closeSenderPCs", socketID)

    if (!senderPCs[socketID]) return

    try {
        await senderPCs[socketID].forEach(async (senderPC) => {
            await senderPC.pc.close()
            const eachSenderPC = await senderPCs[senderPC.id].filter(
                (sPC) => sPC.id === socketID
            )[0]
            if (!eachSenderPC) return
            await eachSenderPC.pc.close()
            senderPCs[senderPC.id] = await senderPCs[senderPC.id].filter(
                (sPC) => sPC.id !== socketID
            )
        })
    } catch (e) {
        console.log(e)
    }

    try {
        await delete senderPCs[socketID]
    } catch (e) {
        console.log(e)
    }
}

// const io = socketio.listen(server); // ?

io.on("connection", (socket) => {
    console.log(socket.id)

    socket.on("joinRoom", async (data) => {
        try {
            let allUsers = await getOtherUsersInRoom(data.id, data.roomID)
            await io.to(data.id).emit("allUsers", {users: allUsers})
            // console.log("emitted allUsers", data.id)
            console.log("joinRoom", allUsers)
        } catch (error) {
            // console.log("joinRoom error")
            console.log(error)
        }
    })

    socket.on("senderOffer", async (data) => {
        console.log("senderOffer", data.senderSocketID)
        try {
            socketToRoom[data.senderSocketID] = data.roomID;
            let pc = await createReceiverPeerConnection(
                data.senderSocketID,
                socket,
                data.roomID
            ) // already saved pc in array (*modified)

            // await pc.setRemoteDescription(data.sdp) // (pc use x)
            let seconds = new Date().getTime() / 1000
            let receiverPCwithID = undefined
            while (receiverPCwithID === undefined && ((new Date().getTime() / 1000) - seconds) < 10) {
                receiverPCwithID = await receiverPCs[data.senderSocketID]
            }
            // await receiverPCs[data.senderSocketID].setRemoteDescription(data.sdp) // access saved array element
            await receiverPCwithID.setRemoteDescription(data.sdp) // access saved array element
            // await console.log("senderOffer setRemoteDescription")

            let sdp = await pc.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            })
            // await pc.setLocalDescription(sdp) // (pc use x)
            // await receiverPCs[data.senderSocketID].setLocalDescription(sdp) // access saved array element
            await receiverPCwithID.setLocalDescription(sdp) // access saved array element
            // await console.log("senderOffer setLocalDescription")

            // receiverPCs[data.senderSocketID] = await pc // save in createReceiverPeerConnection function
            // await console.log("receiverPC saved")

            await socket.join(data.roomID)
            await io.to(data.senderSocketID).emit("getSenderAnswer", { sdp })
            // console.log("emitted getSenderAnswer", data.senderSocketID)
        } catch (error) {
            // console.log("senderOffer error")
            console.log(error)
        }
    })

    socket.on("senderCandidate", async (data) => {
        console.log("senderCandidate", data.senderSocketID)
        try {
            let seconds = new Date().getTime() / 1000
            let pc = undefined
            while (pc === undefined && ((new Date().getTime() / 1000) - seconds < 10)) {
                pc = await receiverPCs[data.senderSocketID]
            }
            await pc.addIceCandidate(await new wrtc.RTCIceCandidate(data.candidate))
        } catch (error) {
            // console.log('senderCandidate error')
            console.log(error);
        }
    })

    socket.on("receiverOffer", async (data) => {
        console.log("receiverOffer", data.senderSocketID, data.receiverSocketID)
        try {
            let pc = await createSenderPeerConnection(
                data.receiverSocketID,
                data.senderSocketID,
                socket,
                data.roomID
            )
            await pc.setRemoteDescription(data.sdp)
            let sdp = await pc.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            })
            await pc.setLocalDescription(sdp)
            await io.to(data.receiverSocketID).emit("getReceiverAnswer", {
                id: data.senderSocketID,
                sdp: sdp
            })
            // console.log("emitted getReceiverAnswer", data.receiverSocketID)
        } catch (error) {
            // console.log("receiverOffer error")
            console.log(error)
        }
    })

    socket.on("receiverCandidate", async (data) => {
        console.log("receiverCandidate", data.senderSocketID, data.receiverSocketID)
        try {
            let seconds = new Date().getTime() / 1000
            let senderPCwithID = undefined
            while(senderPCwithID === undefined && ((new Date().getTime() / 1000) - seconds < 10)) {
                senderPCwithID = await senderPCs[data.senderSocketID]
            }
            // const senderPC = await senderPCs[data.senderSocketID].filter(
            //     (sPC) => sPC.id === data.receiverSocketID
            // )[0]
            const senderPC = await senderPCwithID.filter(
                (sPC) => sPC.id === data.receiverSocketID
            )[0]
            await senderPC.pc.addIceCandidate(
                await new wrtc.RTCIceCandidate(data.candidate)
            )
        } catch (error) {
            // console.log("receiverCandidate error")
            console.log(error)
        }
    })
    
    socket.on("disconnect", async () => {
        try {
            // let socketID = socketIDMap[socket.id]
            let socketID = socket.id
            let roomID = await socketToRoom[socketID]
            // let roomID = socketToRoom[socket.id]
            
            console.log("disconnect", socketID, roomID)

            // deleteUser(socket.id, roomID)
            await deleteUser(socketID, roomID)
            // console.log("disconnect deleteUser executed")

            // closeSenderPCs(socket.id)
            await closeSenderPCs(socketID)
            // console.log("disconnect closeSenderPCs executed")

            // closeReceiverPC(socket.id)
            await socket.disconnect()
            // console.log("disconnect socket disconnected")

            await closeReceiverPC(socketID)
            // console.log("disconnect closeReceiverPC executed")

            // socket.broadcast.to(roomID).emit("userExit", {id: socket.id})
            await socket.broadcast.to(roomID).emit("userExit", {id: socketID})
            // console.log("emitted userExit", socket.id)

        } catch (error) {
            // console.log("disconnect error")
            console.log(error)
        }
    })
})

server.listen(process.env.PORT || 8080, () => {
    console.log("server running on port 8080!")
})