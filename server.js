const express = require("express");
const path = require("path");
const app = express();
const PORT = 3000
const HOST = "localhost";

// Servir la carpeta QWhaleX.io como directorio base estático
app.use(express.static(path.join(__dirname, "Old Narwhale Classic")));

// Configuración para servir subdirectorios específicos
// No necesitas estos en caso de que ya hayas configurado el directorio base correctamente
app.use("/img", express.static(path.join(__dirname, "img")));
app.use("/external", express.static(path.join(__dirname, "external")));
app.use("/css", express.static(path.join(__dirname, "css")));
app.use("/index.html", express.static(path.join(__dirname, "index.html")));
app.use("/app.js", express.static(path.join(__dirname, "app.js")));
app.use("/howareyou.js", express.static(path.join(__dirname, "howareyou.js")));
app.use("/myicon", express.static(path.join(__dirname, "myicon")));
app.use("/pixi.js", express.static(path.join(__dirname, "pixi.js")));
app.use("/js", express.static(path.join(__dirname, "js")));
app.use("main.css", express.static(path.join(__dirname, "main.css")));




// Ruta para servir el archivo index.html
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname,  "index.html"));
});

app.listen(PORT, HOST, () => {
    console.log(`Servidor corriendo en http://${HOST}:${PORT}`);
});
