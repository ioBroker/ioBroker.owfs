![Logo](admin/owfs.png)
ioBroker OWFS Adapter
==============

[![NPM version](http://img.shields.io/npm/v/iobroker.owfs.svg)](https://www.npmjs.com/package/iobroker.owfs)
[![Downloads](https://img.shields.io/npm/dm/iobroker.owfs.svg)](https://www.npmjs.com/package/iobroker.owfs)

[![NPM](https://nodei.co/npm/iobroker.owfs.png?downloads=true)](https://nodei.co/npm/iobroker.owfs/)


# *One wire file system* adapter for ioBroker.

Supported

This adapter uses the owfs library from https://www.npmjs.com/package/owjs and accordingly requires owfs server.

## Install OWFS Linux
```sudo apt-get install owfs```

## Install OWFS windows
http://sourceforge.net/projects/owfs/

## Changelog
### 0.2.0 (2016-07-27)
* (bluefox) discover sensors
* (bluefox) use other npm library to fix write

### 0.1.1 (2016-07-25)
* (bluefox) check configuration

### 0.1.0 (2016-07-08)
* (bluefox) remove rooms
* (bluefox) fix creation of states
* (bluefox) convert states to numbers
* (bluefox) support of quality codes

### 0.0.1 (2014-11-02)
* (bluefox) support of server (actual no authentication)

## Install

```node iobroker.js add owfs```

## Configuration

## License

The MIT License (MIT)

Copyright (c) 2015, bluefox

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
