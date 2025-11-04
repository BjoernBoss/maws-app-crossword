# \[MAWS\] Application to Create and Play Crosswords Together
![JavaScript](https://img.shields.io/badge/language-JavaScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

This application is designed to be used with the [`MAWS-Host`](https://github.com/BjoernBoss/maws-host.git).

It provides an interactive way to create crosswords, which are stored in a given `data-path` (as given to the constructor of the application). Further, it allows to work on the crosswords in tandem, by making use of `WebSockets`.

## Using the Application
To use this application, setup the `maws-host`. Then, simply clone the current application into the apps directory:

	$ git clone https://github.com/BjoernBoss/maws-app-crossword.git apps/crossword

Afterwards, transpile the entire server application, and set it up in the `setup.js Run` method as:

```JavaScript
const app = await import("./crossword/app.js");
server.register('/crossword', new app.Application('path/to/crossword/data'), null);
```
