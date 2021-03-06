/****************************************************************************
**
** Copyright (C) 2015 The Qt Company Ltd.
** Contact: http://www.qt.io/licensing
**
** This file is part of Qbs.
**
** Commercial License Usage
** Licensees holding valid commercial Qt licenses may use this file in
** accordance with the commercial license agreement provided with the
** Software or, alternatively, in accordance with the terms contained in
** a written agreement between you and The Qt Company. For licensing terms and
** conditions see http://www.qt.io/terms-conditions. For further information
** use the contact form at http://www.qt.io/contact-us.
**
** GNU Lesser General Public License Usage
** Alternatively, this file may be used under the terms of the GNU Lesser
** General Public License version 2.1 or version 3 as published by the Free
** Software Foundation and appearing in the file LICENSE.LGPLv21 and
** LICENSE.LGPLv3 included in the packaging of this file.  Please review the
** following information to ensure the GNU Lesser General Public License
** requirements will be met: https://www.gnu.org/licenses/lgpl.html and
** http://www.gnu.org/licenses/old-licenses/lgpl-2.1.html.
**
** In addition, as a special exception, The Qt Company gives you certain additional
** rights.  These rights are described in The Qt Company LGPL Exception
** version 1.1, included in the file LGPL_EXCEPTION.txt in this package.
**
****************************************************************************/

var File = require("qbs.File");
var FileInfo = require("qbs.FileInfo");
var DarwinTools = require("qbs.DarwinTools");
var ModUtils = require("qbs.ModUtils");
var PathTools = require("qbs.PathTools");
var Process = require("qbs.Process");
var TextFile = require("qbs.TextFile");
var UnixUtils = require("qbs.UnixUtils");
var Utilities = require("qbs.Utilities");
var WindowsUtils = require("qbs.WindowsUtils");

function effectiveLinkerPath(product, inputs) {
    if (product.cpp.linkerMode === "automatic") {
        var compilers = product.cpp.compilerPathByLanguage;
        if (compilers) {
            if (inputs.cpp_obj || inputs.cpp_staticlibrary) {
                console.log("Found C++ or Objective-C++ objects, choosing C++ linker for "
                            + product.name);
                return compilers["cpp"];
            }

            if (inputs.c_obj || inputs.c_staticlibrary) {
                console.log("Found C or Objective-C objects, choosing C linker for "
                            + product.name);
                return compilers["c"];
            }
        }

        console.log("Found no C-language objects, choosing system linker for "
                    + product.name);
    }

    return product.cpp.linkerPath;
}

function useCompilerDriverLinker(product, inputs) {
    var linker = effectiveLinkerPath(product, inputs);
    var compilers = product.cpp.compilerPathByLanguage;
    if (compilers) {
        return linker === compilers["cpp"]
            || linker === compilers["c"];
    }
    return linker === product.cpp.compilerPath;
}

function collectLibraryDependencies(product, isDarwin) {
    var publicDeps = {};
    var objects = [];
    var objectByFilePath = {};

    function addObject(obj, addFunc) {
        addFunc.call(objects, obj);
        objectByFilePath[obj.filePath] = obj;
    }

    function addPublicFilePath(filePath, dep) {
        var existing = objectByFilePath[filePath];
        var wholeArchive = dep.parameters.cpp && dep.parameters.cpp.linkWholeArchive;
        var symbolLinkMode = dep.parameters.cpp && dep.parameters.cpp.symbolLinkMode;
        if (existing) {
            existing.direct = true;
            existing.wholeArchive = wholeArchive;
            existing.symbolLinkMode = symbolLinkMode;
        } else {
            addObject({ direct: true, filePath: filePath,
                        wholeArchive: wholeArchive, symbolLinkMode: symbolLinkMode },
                      Array.prototype.unshift);
        }
    }

    function addPrivateFilePath(filePath) {
        var existing = objectByFilePath[filePath];
        if (!existing)
            addObject({ direct: false, filePath: filePath }, Array.prototype.unshift);
    }

    function addArtifactFilePaths(dep, tag, addFunction) {
        var artifacts = dep.artifacts[tag];
        if (!artifacts)
            return;
        var artifactFilePaths = artifacts.map(function(a) { return a.filePath; });
        for (var i = 0; i < artifactFilePaths.length; ++i)
           addFunction(artifactFilePaths[i], dep);
    }

    function addExternalLibs(obj) {
        var externalLibs = [].concat(
                    ModUtils.sanitizedModuleProperty(obj, "cpp", "staticLibraries"),
                    ModUtils.sanitizedModuleProperty(obj, "cpp", "dynamicLibraries"));
        for (var i = 0, len = externalLibs.length; i < len; ++i)
            addObject({ direct: true, filePath: externalLibs[i] }, Array.prototype.push);
        if (isDarwin) {
            externalLibs = [].concat(
                        ModUtils.sanitizedModuleProperty(obj, "cpp", "frameworks"));
            for (var i = 0, len = externalLibs.length; i < len; ++i)
                addObject({ direct: true, filePath: externalLibs[i], framework: true },
                        Array.prototype.push);
            externalLibs = [].concat(
                        ModUtils.sanitizedModuleProperty(obj, "cpp", "weakFrameworks"));
            for (var i = 0, len = externalLibs.length; i < len; ++i)
                addObject({ direct: true, filePath: externalLibs[i], framework: true,
                            symbolLinkMode: "weak" }, Array.prototype.push);
        }
    }

    function traverse(dep, isBelowIndirectDynamicLib) {
        if (publicDeps[dep.name])
            return;

        if (dep.parameters.cpp && dep.parameters.cpp.link === false)
            return;

        var isStaticLibrary = typeof dep.artifacts["staticlibrary"] !== "undefined";
        var isDynamicLibrary = !isStaticLibrary
                && typeof dep.artifacts["dynamiclibrary"] !== "undefined";
        if (!isStaticLibrary && !isDynamicLibrary)
            return;

        var nextIsBelowIndirectDynamicLib = isBelowIndirectDynamicLib || isDynamicLibrary;
        dep.dependencies.forEach(function(depdep) {
            traverse(depdep, nextIsBelowIndirectDynamicLib);
        });
        if (isStaticLibrary) {
            if (!isBelowIndirectDynamicLib) {
                addArtifactFilePaths(dep, "staticlibrary", addPublicFilePath);
                addExternalLibs(dep);
                publicDeps[dep.name] = true;
            }
        } else if (isDynamicLibrary) {
            if (!isBelowIndirectDynamicLib) {
                addArtifactFilePaths(dep, "dynamiclibrary", addPublicFilePath);
                publicDeps[dep.name] = true;
            } else {
                addArtifactFilePaths(dep, "dynamiclibrary", addPrivateFilePath);
            }
        }
    }

    function traverseDirectDependency(dep) {
        traverse(dep, false);
    }

    product.dependencies.forEach(traverseDirectDependency);
    addExternalLibs(product);

    var seenRPathLinkDirs = {};
    var result = { libraries: [], rpath_link: [] };
    objects.forEach(
                function (obj) {
                    if (obj.direct) {
                        result.libraries.push({ filePath: obj.filePath,
                                                wholeArchive: obj.wholeArchive,
                                                symbolLinkMode: obj.symbolLinkMode,
                                                framework: obj.framework });
                    } else {
                        var dirPath = FileInfo.path(obj.filePath);
                        if (!seenRPathLinkDirs.hasOwnProperty(dirPath)) {
                            seenRPathLinkDirs[dirPath] = true;
                            result.rpath_link.push(dirPath);
                        }
                    }
                });
    return result;
}

function escapeLinkerFlags(product, inputs, linkerFlags) {
    if (!linkerFlags || linkerFlags.length === 0)
        return [];

    if (useCompilerDriverLinker(product, inputs)) {
        var sep = ",";
        var useXlinker = linkerFlags.some(function (f) { return f.contains(sep); });
        if (useXlinker) {
            // One or more linker arguments contain the separator character itself
            // Use -Xlinker to handle these
            var xlinkerFlags = [];
            linkerFlags.map(function (linkerFlag) {
                if (product.cpp.enableSuspiciousLinkerFlagWarnings
                        && linkerFlag.startsWith("-Wl,")) {
                    console.warn("Encountered escaped linker flag '" + linkerFlag + "'. This may " +
                                 "cause the target to fail to link. Please do not escape these " +
                                 "flags manually; qbs does that for you.");
                }
                xlinkerFlags.push("-Xlinker", linkerFlag);
            });
            return xlinkerFlags;
        }

        if (product.cpp.enableSuspiciousLinkerFlagWarnings && linkerFlags.contains("-Xlinker")) {
            console.warn("Encountered -Xlinker linker flag escape sequence. This may cause the " +
                         "target to fail to link. Please do not escape these flags manually; " +
                         "qbs does that for you.");
        }

        // If no linker arguments contain the separator character we can just use -Wl,
        // which is more compact and easier to read in logs
        return [["-Wl"].concat(linkerFlags).join(sep)];
    }

    return linkerFlags;
}

function linkerFlags(project, product, inputs, output, linkerPath) {
    var libraryPaths = product.cpp.libraryPaths;
    var distributionLibraryPaths = product.cpp.distributionLibraryPaths;
    var isDarwin = product.qbs.targetOS.contains("darwin");
    var libraryDependencies = collectLibraryDependencies(product, isDarwin);
    var frameworks = product.cpp.frameworks;
    var weakFrameworks = product.cpp.weakFrameworks;
    var rpaths = (product.cpp.useRPaths !== false) ? product.cpp.rpaths : undefined;
    var systemRunPaths = product.cpp.systemRunPaths || [];
    var i, args = additionalCompilerAndLinkerFlags(product);

    if (output.fileTags.contains("dynamiclibrary")) {
        if (isDarwin) {
            args.push((function () {
                var tags = ["c", "cpp", "objc", "objcpp", "asm_cpp"];
                for (var i = 0; i < tags.length; ++i) {
                    if (linkerPath === product.cpp.compilerPathByLanguage[tags[i]])
                        return "-dynamiclib";
                }
                return "-dylib"; // for ld64
            })());
        } else {
            args.push("-shared");
        }

        if (isDarwin) {
            var internalVersion = product.cpp.internalVersion;
            if (internalVersion && isNumericProductVersion(internalVersion))
                args.push("-current_version", internalVersion);

            args = args.concat(escapeLinkerFlags(product, inputs, [
                                                     "-install_name",
                                                     UnixUtils.soname(product, output.fileName)]));
        } else {
            args = args.concat(escapeLinkerFlags(product, inputs, [
                                                     "-soname=" +
                                                     UnixUtils.soname(product, output.fileName)]));
        }
    }

    if (output.fileTags.contains("loadablemodule"))
        args.push(isDarwin ? "-bundle" : "-shared");

    if (output.fileTags.containsAny(["dynamiclibrary", "loadablemodule"])) {
        if (isDarwin)
            args = args.concat(escapeLinkerFlags(product, inputs,
                                                 ["-headerpad_max_install_names"]));
        else
            args = args.concat(escapeLinkerFlags(product, inputs,
                                                 ["--as-needed"]));
    }

    if (isLegacyQnxSdk(product)) {
        ["c", "cpp"].map(function (tag) {
            if (linkerPath === product.cpp.compilerPathByLanguage[tag])
                args = args.concat(qnxLangArgs(product, tag));
        });
    }

    var targetLinkerFlags = product.cpp.targetLinkerFlags;
    if (targetLinkerFlags)
        args = args.concat(escapeLinkerFlags(product, inputs, targetLinkerFlags));

    var sysroot = product.cpp.syslibroot;
    if (sysroot) {
        if (product.qbs.toolchain.contains("qcc"))
            args = args.concat(escapeLinkerFlags(product, inputs, ["--sysroot=" + sysroot]));
        else if (isDarwin)
            args = args.concat(escapeLinkerFlags(product, inputs, ["-syslibroot", sysroot]));
        else
            args.push("--sysroot=" + sysroot); // do not escape, compiler-as-linker also needs it
    }

    if (isDarwin) {
        var unresolvedSymbolsAction;
        unresolvedSymbolsAction = product.cpp.allowUnresolvedSymbols
                                    ? "suppress" : "error";
        args = args.concat(escapeLinkerFlags(product, inputs,
                                             ["-undefined", unresolvedSymbolsAction]));
    } else if (product.cpp.allowUnresolvedSymbols) {
        args = args.concat(escapeLinkerFlags(product, inputs,
                                             ["--unresolved-symbols=ignore-all"]));
    }

    for (i in rpaths) {
        if (systemRunPaths.indexOf(rpaths[i]) === -1)
            args = args.concat(escapeLinkerFlags(product, inputs, ["-rpath", rpaths[i]]));
    }

    if (product.cpp.entryPoint)
        args = args.concat(escapeLinkerFlags(product, inputs,
                                             ["-e", product.cpp.entryPoint]));

    if (product.qbs.toolchain.contains("mingw")) {
        if (product.consoleApplication !== undefined)
            args = args.concat(escapeLinkerFlags(product, inputs, [
                                                     "-subsystem",
                                                     product.consoleApplication
                                                        ? "console"
                                                        : "windows"]));

        var minimumWindowsVersion = product.cpp.minimumWindowsVersion;
        if (minimumWindowsVersion) {
            var subsystemVersion = WindowsUtils.getWindowsVersionInFormat(minimumWindowsVersion, 'subsystem');
            if (subsystemVersion) {
                var major = subsystemVersion.split('.')[0];
                var minor = subsystemVersion.split('.')[1];

                // http://sourceware.org/binutils/docs/ld/Options.html
                args = args.concat(escapeLinkerFlags(product, inputs,
                                                     ["--major-subsystem-version", major]));
                args = args.concat(escapeLinkerFlags(product, inputs,
                                                     ["--minor-subsystem-version", minor]));
                args = args.concat(escapeLinkerFlags(product, inputs,
                                                     ["--major-os-version", major]));
                args = args.concat(escapeLinkerFlags(product, inputs,
                                                     ["--minor-os-version", minor]));
            }
        }
    }

    if (inputs.aggregate_infoplist)
        args.push("-sectcreate", "__TEXT", "__info_plist", inputs.aggregate_infoplist[0].filePath);

    var isLinkingCppObjects = !!(inputs.cpp_obj || inputs.cpp_staticlibrary);
    var stdlib = isLinkingCppObjects
            ? product.cpp.cxxStandardLibrary
            : undefined;
    if (stdlib && product.qbs.toolchain.contains("clang"))
        args.push("-stdlib=" + stdlib);

    // Flags for library search paths
    var allLibraryPaths = [];
    if (libraryPaths)
        allLibraryPaths = allLibraryPaths.uniqueConcat(libraryPaths);
    if (distributionLibraryPaths)
        allLibraryPaths = allLibraryPaths.uniqueConcat(distributionLibraryPaths);
    args = args.concat(allLibraryPaths.map(function(path) { return '-L' + path }));

    var linkerScripts = inputs.linkerscript
            ? inputs.linkerscript.map(function(a) { return a.filePath; }) : [];
    args = args.concat(escapeLinkerFlags(product, inputs, [].uniqueConcat(linkerScripts)
                                         .map(function(path) { return '-T' + path })));

    var versionScripts = inputs.versionscript
            ? inputs.versionscript.map(function(a) { return a.filePath; }) : [];
    args = args.concat(escapeLinkerFlags(product, inputs, [].uniqueConcat(versionScripts)
                       .map(function(path) { return '--version-script=' + path })));

    if (isDarwin && product.cpp.warningLevel === "none")
        args.push('-w');

    args = args.concat(configFlags(product, useCompilerDriverLinker(product, inputs)));
    args = args.concat(escapeLinkerFlags(
                           product, inputs, product.cpp.platformLinkerFlags));
    args = args.concat(escapeLinkerFlags(product, inputs, product.cpp.linkerFlags));

    // Note: due to the QCC response files hack in prepareLinker(), at least one object file or
    // library file must follow the output file path so that QCC has something to process before
    // sending the rest of the arguments through the response file.
    args.push("-o", output.filePath);

    if (inputs.obj)
        args = args.concat(inputs.obj.map(function (obj) { return obj.filePath }));

    for (i in frameworks) {
        frameworkExecutablePath = PathTools.frameworkExecutablePath(frameworks[i]);
        if (FileInfo.isAbsolutePath(frameworkExecutablePath))
            args.push(frameworkExecutablePath);
        else
            args = args.concat(['-framework', frameworks[i]]);
    }

    for (i in weakFrameworks) {
        frameworkExecutablePath = PathTools.frameworkExecutablePath(weakFrameworks[i]);
        if (FileInfo.isAbsolutePath(frameworkExecutablePath))
            args = args.concat(['-weak_library', frameworkExecutablePath]);
        else
            args = args.concat(['-weak_framework', weakFrameworks[i]]);
    }

    var wholeArchiveActive = false;
    for (i = 0; i < libraryDependencies.libraries.length; ++i) {
        var dep = libraryDependencies.libraries[i];
        var lib = dep.filePath;
        if (dep.wholeArchive && !wholeArchiveActive) {
            var wholeArchiveFlag;
            if (isDarwin) {
                wholeArchiveFlag = "-force_load";
            } else {
                wholeArchiveFlag = "--whole-archive";
                wholeArchiveActive = true;
            }
            Array.prototype.push.apply(args,
                                       escapeLinkerFlags(product, inputs, [wholeArchiveFlag]));
        }
        if (!dep.wholeArchive && wholeArchiveActive) {
            Array.prototype.push.apply(args,
                                       escapeLinkerFlags(product, inputs, ["--no-whole-archive"]));
            wholeArchiveActive = false;
        }

        var symbolLinkMode = dep.symbolLinkMode;
        if (isDarwin && symbolLinkMode) {
            if (!["lazy", "reexport", "upward", "weak"].contains(symbolLinkMode))
                throw new Error("unknown value '" + symbolLinkMode + "' for cpp.symbolLinkMode");

            var flags;
            if (FileInfo.isAbsolutePath(lib) || lib.startsWith('@'))
                flags = ["-" + symbolLinkMode + "_library", lib];
            else if (dep.framework)
                flags = ["-" + symbolLinkMode + "_framework", lib];
            else
                flags = ["-" + symbolLinkMode + "-l" + lib];

            Array.prototype.push.apply(args, escapeLinkerFlags(product, inputs, flags));
        } else if (FileInfo.isAbsolutePath(lib) || lib.startsWith('@')) {
            args.push(dep.framework ? PathTools.frameworkExecutablePath(lib) : lib);
        } else if (dep.framework) {
            args.push("-framework", lib);
        } else {
            args.push('-l' + lib);
        }
    }
    if (wholeArchiveActive) {
        Array.prototype.push.apply(args,
                                   escapeLinkerFlags(product, inputs, ["--no-whole-archive"]));
    }

    if (product.cpp.useRPathLink) {
        if (!product.cpp.rpathLinkFlag)
            throw new Error("Using rpath-link but cpp.rpathLinkFlag is not defined");
        args = args.concat(escapeLinkerFlags(
                               product, inputs,
                               libraryDependencies.rpath_link.map(
                                   function(dir) {
                                       return product.cpp.rpathLinkFlag + dir;
                                   })));
    }

    return args;
}

// for compiler AND linker
function configFlags(config, isDriver) {
    var args = [];

    if (isDriver !== false) {
        args = args.concat(config.cpp.platformDriverFlags);
        args = args.concat(config.cpp.driverFlags);
        args = args.concat(config.cpp.targetDriverFlags);
    }

    var frameworkPaths = config.cpp.frameworkPaths;
    if (frameworkPaths)
        args = args.concat(frameworkPaths.map(function(path) { return '-F' + path }));

    var allSystemFrameworkPaths = [];

    var systemFrameworkPaths = config.cpp.systemFrameworkPaths;
    if (systemFrameworkPaths)
        allSystemFrameworkPaths = allSystemFrameworkPaths.uniqueConcat(systemFrameworkPaths);

    var distributionFrameworkPaths = config.cpp.distributionFrameworkPaths;
    if (distributionFrameworkPaths)
        allSystemFrameworkPaths = allSystemFrameworkPaths.uniqueConcat(distributionFrameworkPaths);

    args = args.concat(allSystemFrameworkPaths.map(function(path) { return '-iframework' + path }));

    return args;
}

function languageTagFromFileExtension(toolchain, fileName) {
    var i = fileName.lastIndexOf('.');
    if (i === -1)
        return;
    var m = {
        "c"     : "c",
        "C"     : "cpp",
        "cpp"   : "cpp",
        "cxx"   : "cpp",
        "c++"   : "cpp",
        "cc"    : "cpp",
        "m"     : "objc",
        "mm"    : "objcpp",
        "s"     : "asm",
        "S"     : "asm_cpp"
    };
    if (!toolchain.contains("clang"))
        m["sx"] = "asm_cpp"; // clang does NOT recognize .sx
    return m[fileName.substring(i + 1)];
}

// Older versions of the QNX SDK have C and C++ compilers whose filenames differ only by case,
// which won't work in case insensitive environments like Win32+NTFS, HFS+ and APFS
function isLegacyQnxSdk(config) {
    return config.qbs.toolchain.contains("qcc") && config.qnx && !config.qnx.qnx7;
}

function effectiveCompilerInfo(toolchain, input, output) {
    var compilerPath, language;
    var tag = ModUtils.fileTagForTargetLanguage(input.fileTags.concat(output.fileTags));

    // Whether we're compiling a precompiled header or normal source file
    var pchOutput = output.fileTags.contains(tag + "_pch");

    var compilerPathByLanguage = input.cpp.compilerPathByLanguage;
    if (compilerPathByLanguage)
        compilerPath = compilerPathByLanguage[tag];
    if (!compilerPath
            || tag !== languageTagFromFileExtension(toolchain, input.fileName)
            || isLegacyQnxSdk(input)) {
        if (input.qbs.toolchain.contains("qcc"))
            language = qnxLangArgs(input, tag);
        else
            language = ["-x", languageName(tag) + (pchOutput ? '-header' : '')];
    }
    if (!compilerPath)
        // fall back to main compiler
        compilerPath = input.cpp.compilerPath;
    return {
        path: compilerPath,
        language: language,
        tag: tag
    };
}


function qnxLangArgs(config, tag) {
    switch (tag) {
    case "c":
        return ["-lang-c"];
    case "cpp":
        return ["-lang-c++"];
    default:
        return [];
    }
}

function compilerFlags(project, product, input, output, explicitlyDependsOn) {
    var i;

    var includePaths = input.cpp.includePaths;
    var systemIncludePaths = input.cpp.systemIncludePaths;
    var distributionIncludePaths = input.cpp.distributionIncludePaths;

    var platformDefines = input.cpp.platformDefines;
    var defines = input.cpp.defines;

    // Determine which C-language we're compiling
    var tag = ModUtils.fileTagForTargetLanguage(input.fileTags.concat(output.fileTags));
    if (!["c", "cpp", "objc", "objcpp", "asm_cpp"].contains(tag))
        throw ("unsupported source language: " + tag);

    var compilerInfo = effectiveCompilerInfo(product.qbs.toolchain,
                                             input, output);

    var args = additionalCompilerAndLinkerFlags(product);

    Array.prototype.push.apply(args, product.cpp.sysrootFlags);

    if (input.cpp.debugInformation)
        args.push('-g');
    var opt = input.cpp.optimization
    if (opt === 'fast')
        args.push('-O2');
    if (opt === 'small')
        args.push('-Os');
    if (opt === 'none')
        args.push('-O0');

    var warnings = input.cpp.warningLevel
    if (warnings === 'none')
        args.push('-w');
    if (warnings === 'all') {
        args.push('-Wall');
        args.push('-Wextra');
    }
    if (input.cpp.treatWarningsAsErrors)
        args.push('-Werror');

    args = args.concat(configFlags(input));

    if (!input.qbs.toolchain.contains("qcc"))
        args.push('-pipe');

    if (input.cpp.enableReproducibleBuilds) {
        var toolchain = product.qbs.toolchain;
        if (!toolchain.contains("clang")) {
            var hashString = FileInfo.relativePath(project.sourceDirectory, input.filePath);
            var hash = Utilities.getHash(hashString);
            args.push("-frandom-seed=0x" + hash.substring(0, 8));
        }

        var major = product.cpp.compilerVersionMajor;
        var minor = product.cpp.compilerVersionMinor;
        if ((toolchain.contains("clang") && (major > 3 || (major === 3 && minor >= 5))) ||
            (toolchain.contains("gcc") && (major > 4 || (major === 4 && minor >= 9)))) {
            args.push("-Wdate-time");
        }
    }

    var useArc = input.cpp.automaticReferenceCounting;
    if (useArc !== undefined && (tag === "objc" || tag === "objcpp")) {
        args.push(useArc ? "-fobjc-arc" : "-fno-objc-arc");
    }

    var enableExceptions = input.cpp.enableExceptions;
    if (enableExceptions !== undefined) {
        if (tag === "cpp" || tag === "objcpp")
            args.push(enableExceptions ? "-fexceptions" : "-fno-exceptions");

        if (tag === "objc" || tag === "objcpp") {
            args.push(enableExceptions ? "-fobjc-exceptions" : "-fno-objc-exceptions");
            if (useArc !== undefined)
                args.push(useArc ? "-fobjc-arc-exceptions" : "-fno-objc-arc-exceptions");
        }
    }

    var enableRtti = input.cpp.enableRtti;
    if (enableRtti !== undefined && (tag === "cpp" || tag === "objcpp")) {
        args.push(enableRtti ? "-frtti" : "-fno-rtti");
    }

    var visibility = input.cpp.visibility;
    if (!product.qbs.toolchain.contains("mingw")) {
        if (visibility === 'hidden' || visibility === 'minimal')
            args.push('-fvisibility=hidden');
        if ((visibility === 'hiddenInlines' || visibility === 'minimal') && tag === 'cpp')
            args.push('-fvisibility-inlines-hidden');
        if (visibility === 'default')
            args.push('-fvisibility=default')
    }

    var prefixHeaders = input.cpp.prefixHeaders;
    for (i in prefixHeaders) {
        args.push('-include');
        args.push(prefixHeaders[i]);
    }

    if (compilerInfo.language)
        // Only push language arguments if we have to.
        Array.prototype.push.apply(args, compilerInfo.language);

    args = args.concat(ModUtils.moduleProperty(input, 'platformFlags'),
                       ModUtils.moduleProperty(input, 'flags'),
                       ModUtils.moduleProperty(input, 'platformFlags', tag),
                       ModUtils.moduleProperty(input, 'flags', tag));

    var pchTag = compilerInfo.tag + "_pch";
    var pchOutput = output.fileTags.contains(pchTag);
    var pchInputs = explicitlyDependsOn[pchTag];
    if (!pchOutput && pchInputs && pchInputs.length === 1
            && ModUtils.moduleProperty(input, 'usePrecompiledHeader', tag)) {
        var pchInput = pchInputs[0];
        var pchFilePath = FileInfo.joinPaths(FileInfo.path(pchInput.filePath),
                                             pchInput.completeBaseName);
        args.push('-include', pchFilePath);
    }

    var positionIndependentCode = input.cpp.positionIndependentCode;
    if (positionIndependentCode && !product.qbs.toolchain.contains("mingw"))
        args.push('-fPIC');

    var cppFlags = input.cpp.cppFlags;
    for (i in cppFlags)
        args.push('-Wp,' + cppFlags[i])

    var allDefines = [];
    if (platformDefines)
        allDefines = allDefines.uniqueConcat(platformDefines);
    if (defines)
        allDefines = allDefines.uniqueConcat(defines);
    args = args.concat(allDefines.map(function(define) { return '-D' + define }));
    if (includePaths) {
        args = args.concat([].uniqueConcat(includePaths).map(function(path) {
            return input.cpp.includeFlag + path;
        }));
    }

    var allSystemIncludePaths = [];
    if (systemIncludePaths)
        allSystemIncludePaths = allSystemIncludePaths.uniqueConcat(systemIncludePaths);
    if (distributionIncludePaths)
        allSystemIncludePaths = allSystemIncludePaths.uniqueConcat(distributionIncludePaths);
    args = args.concat(allSystemIncludePaths.map(function(path) {
        return input.cpp.systemIncludeFlag + path;
    }));

    var minimumWindowsVersion = input.cpp.minimumWindowsVersion;
    if (minimumWindowsVersion && product.qbs.targetOS.contains("windows")) {
        var hexVersion = WindowsUtils.getWindowsVersionInFormat(minimumWindowsVersion, 'hex');
        if (hexVersion) {
            var versionDefs = [ 'WINVER', '_WIN32_WINNT', '_WIN32_WINDOWS' ];
            for (i in versionDefs)
                args.push('-D' + versionDefs[i] + '=' + hexVersion);
        }
    }

    if (tag === "c" || tag === "objc") {
        var cVersion = input.cpp.cLanguageVersion;
        if (cVersion) {
            var gccCVersionsMap = {
                "c11": "c1x" // Deprecated, but compatible with older gcc versions.
            };
            args.push("-std=" + (gccCVersionsMap[cVersion] || cVersion));
        }
    }

    if (tag === "cpp" || tag === "objcpp") {
        var cxxVersion = input.cpp.cxxLanguageVersion;
        if (cxxVersion) {
            var gccCxxVersionsMap = {
                "c++11": "c++0x", // Deprecated, but compatible with older gcc versions.
                "c++14": "c++1y"
            };
            args.push("-std=" + (gccCxxVersionsMap[cxxVersion] || cxxVersion));
        }

        var cxxStandardLibrary = product.cpp.cxxStandardLibrary;
        if (cxxStandardLibrary && product.qbs.toolchain.contains("clang")) {
            args.push("-stdlib=" + cxxStandardLibrary);
        }
    }

    args.push("-o", output.filePath);
    args.push("-c", input.filePath);

    return args;
}

function additionalCompilerAndLinkerFlags(product) {
    var args = []

    var requireAppExtensionSafeApi = product.cpp.requireAppExtensionSafeApi;
    if (requireAppExtensionSafeApi !== undefined && product.qbs.targetOS.contains("darwin")) {
        args.push(requireAppExtensionSafeApi ? "-fapplication-extension" : "-fno-application-extension");
    }

    return args
}

// Returns the GCC language name equivalent to fileTag, accepted by the -x argument
function languageName(fileTag) {
    if (fileTag === 'c')
        return 'c';
    else if (fileTag === 'cpp')
        return 'c++';
    else if (fileTag === 'objc')
        return 'objective-c';
    else if (fileTag === 'objcpp')
        return 'objective-c++';
    else if (fileTag === 'asm')
        return 'assembler';
    else if (fileTag === 'asm_cpp')
        return 'assembler-with-cpp';
}

function prepareAssembler(project, product, inputs, outputs, input, output) {
    var assemblerPath = product.cpp.assemblerPath;

    var includePaths = input.cpp.includePaths;
    var systemIncludePaths = input.cpp.systemIncludePaths;
    var distributionIncludePaths = input.cpp.distributionIncludePaths;

    var args = product.cpp.targetAssemblerFlags;

    if (input.cpp.debugInformation)
        args.push('-g');

    var warnings = input.cpp.warningLevel
    if (warnings === 'none')
        args.push('-W');

    var tag = "asm";
    args = args.concat(ModUtils.moduleProperty(input, 'platformFlags', tag),
                       ModUtils.moduleProperty(input, 'flags', tag));

    var allIncludePaths = [];
    if (includePaths)
        allIncludePaths = allIncludePaths.uniqueConcat(includePaths);
    if (systemIncludePaths)
        allIncludePaths = allIncludePaths.uniqueConcat(systemIncludePaths);
    if (distributionIncludePaths)
        allIncludePaths = allIncludePaths.uniqueConcat(distributionIncludePaths);
    args = args.concat(allIncludePaths.map(function(path) { return input.cpp.includeFlag + path }));

    args.push("-o", output.filePath);
    args.push(input.filePath);

    var cmd = new Command(assemblerPath, args);
    cmd.description = "assembling " + input.fileName;
    cmd.highlight = "compiler";
    return cmd;
}

function nativeConfigString(product) {
    var props = [];
    if ((product.multiplexed || product.aggregate) && product.multiplexConfigurationId) {
        if (product.qbs.targetOS.containsAny(["android", "darwin"]))
            props.push(product.qbs.architecture);
        if (product.qbs.targetOS.contains("darwin"))
            props.push(product.qbs.buildVariant);
    }
    return props.length > 0 ? (" (" + props.join(", ") + ")") : "";
}

function compilerEnvVars(config, compilerInfo)
{
    if (config.qbs.toolchain.contains("qcc"))
        return ["QCC_CONF_PATH"];

    var list = ["CPATH", "TMPDIR"];
    if (compilerInfo.tag === "c")
        list.push("C_INCLUDE_PATH");
    else if (compilerInfo.tag === "cpp")
        list.push("CPLUS_INCLUDE_PATH");
    else if (compilerInfo.tag === "objc")
        list.push("OBJC_INCLUDE_PATH");
    else if (compilerInfo.tag === "objccpp")
        list.push("OBJCPLUS_INCLUDE_PATH");
    if (config.qbs.targetOS.contains("macos"))
        list.push("MACOSX_DEPLOYMENT_TARGET");
    else if (config.qbs.targetOS.contains("ios"))
        list.push("IPHONEOS_DEPLOYMENT_TARGET");
    else if (config.qbs.targetOS.contains("tvos"))
        list.push("TVOS_DEPLOYMENT_TARGET");
    else if (config.qbs.targetOS.contains("watchos"))
        list.push("WATCHOS_DEPLOYMENT_TARGET");
    if (config.qbs.toolchain.contains("clang")) {
        list.push("TEMP", "TMP");
    } else {
        list.push("LANG", "LC_CTYPE", "LC_MESSAGES", "LC_ALL", "GCC_COMPARE_DEBUG",
                  "GCC_EXEC_PREFIX", "COMPILER_PATH", "SOURCE_DATE_EPOCH");
    }
    return list;
}

function linkerEnvVars(config, inputs)
{
    if (config.qbs.toolchain.contains("clang") || config.qbs.toolchain.contains("qcc"))
        return [];
    var list = ["GNUTARGET", "LDEMULATION", "COLLECT_NO_DEMANGLE"];
    if (useCompilerDriverLinker(config, inputs))
        list.push("LIBRARY_PATH");
    return list;
}

function prepareCompiler(project, product, inputs, outputs, input, output, explicitlyDependsOn) {
    var compilerInfo = effectiveCompilerInfo(product.qbs.toolchain,
                                             input, output);
    var compilerPath = compilerInfo.path;
    var pchOutput = output.fileTags.contains(compilerInfo.tag + "_pch");

    var args = compilerFlags(project, product, input, output, explicitlyDependsOn);
    var wrapperArgsLength = 0;
    var wrapperArgs = product.cpp.compilerWrapper;
    if (wrapperArgs && wrapperArgs.length > 0) {
        wrapperArgsLength = wrapperArgs.length;
        args.unshift(compilerPath);
        compilerPath = wrapperArgs.shift();
        args = wrapperArgs.concat(args);
    }

    var cmd = new Command(compilerPath, args);
    cmd.description = (pchOutput ? 'pre' : '') + 'compiling ' + input.fileName;
    if (pchOutput)
        cmd.description += ' (' + compilerInfo.tag + ')';
    cmd.description += nativeConfigString(product);
    cmd.highlight = "compiler";
    cmd.relevantEnvironmentVariables = compilerEnvVars(input, compilerInfo);
    cmd.responseFileArgumentIndex = wrapperArgsLength;
    cmd.responseFileUsagePrefix = '@';
    return cmd;
}

// Concatenates two arrays of library names and preserves the dependency order that ld needs.
function concatLibs(libs, deplibs) {
    var r = [];
    var s = {};

    function addLibs(lst) {
        for (var i = lst.length; --i >= 0;) {
            var lib = lst[i];
            if (!s[lib]) {
                s[lib] = true;
                r.unshift(lib);
            }
        }
    }

    addLibs(deplibs);
    addLibs(libs);
    return r;
}

function collectStdoutLines(command, args)
{
    var p = new Process();
    try {
        p.exec(command, args);
        return p.readStdOut().split('\n').filter(function (e) { return e; });
    } finally {
        p.close();
    }
}

function getSymbolInfo(product, inputFile)
{
    var result = { };
    var command = product.cpp.nmPath;
    var args = ["-g", "-P"];
    if (product.cpp._nmHasDynamicOption)
        args.push("-D");
    try {
        result.allGlobalSymbols = collectStdoutLines(command, args.concat(inputFile));

        // GNU nm has the "--defined" option but POSIX nm does not, so we have to manually
        // construct the list of defined symbols by subtracting.
        var undefinedGlobalSymbols = collectStdoutLines(command, args.concat(["-u", inputFile]));
        result.definedGlobalSymbols = result.allGlobalSymbols.filter(function(line) {
            return !undefinedGlobalSymbols.contains(line); });
        result.success = true;
    } catch (e) {
        console.debug("Failed to collect symbols for shared library: nm command '"
                      + command + "' failed (" + e.toString() + ")");
        result.success = false;
    }
    return result;
}

function createSymbolFile(filePath, allSymbols, definedSymbols)
{
    var file;
    try {
        file = new TextFile(filePath, TextFile.WriteOnly);
        for (var lineNr in allSymbols)
            file.writeLine(allSymbols[lineNr]);
        file.writeLine("===");
        for (lineNr in definedSymbols)
            file.writeLine(definedSymbols[lineNr]);
    } finally {
        if (file)
            file.close();
    }
}

function readSymbolFile(filePath)
{
    var result = { success: true, allGlobalSymbols: [], definedGlobalSymbols: [] };
    var file;
    try {
        file = new TextFile(filePath, TextFile.ReadOnly);
        var prop = "allGlobalSymbols";
        while (true) {
            var line = file.readLine();
            if (!line)
                break;
            if (line === "===") {
                prop = "definedGlobalSymbols";
                continue;
            }
            result[prop].push(line);
        }
    } catch (e) {
        console.debug("Failed to read symbols from '" + filePath + "'");
        result.success = false;
    } finally {
        if (file)
            file.close();
    }
    return result;
}

function createSymbolCheckingCommands(product, outputs) {
    var commands = [];
    if (!outputs.dynamiclibrary || !outputs.dynamiclibrary_copy)
        return commands;

    if (outputs.dynamiclibrary.length !== outputs.dynamiclibrary_copy.length)
        throw new Error("The number of outputs tagged dynamiclibrary ("
                        + outputs.dynamiclibrary.length + ") must be equal to the number of "
                        + "outputs tagged dynamiclibrary_copy ("
                        + outputs.dynamiclibrary_copy.length + ")");

    for (var d = 0; d < outputs.dynamiclibrary_copy.length; ++d) {
        // Update the symbols file if the list of relevant symbols has changed.
        var cmd = new JavaScriptCommand();
        cmd.silent = true;
        cmd.d = d;
        cmd.sourceCode = function() {
            if (outputs.dynamiclibrary[d].qbs.buildVariant
                    !== outputs.dynamiclibrary_copy[d].qbs.buildVariant)
                throw new Error("Build variant of output tagged dynamiclibrary ("
                                + outputs.dynamiclibrary[d].qbs.buildVariant + ") is not equal to "
                                + "build variant of output tagged dynamiclibrary_copy ("
                                + outputs.dynamiclibrary_copy[d].qbs.buildVariant + ") at index "
                                + d);

            var libFilePath = outputs.dynamiclibrary[d].filePath;
            var symbolFilePath = outputs.dynamiclibrary_copy[d].filePath;

            var newNmResult = getSymbolInfo(product, libFilePath);
            if (!newNmResult.success)
                return;

            if (!File.exists(symbolFilePath)) {
                console.debug("Symbol file '" + symbolFilePath + "' does not yet exist.");
                createSymbolFile(symbolFilePath, newNmResult.allGlobalSymbols,
                                 newNmResult.definedGlobalSymbols);
                return;
            }

            var oldNmResult = readSymbolFile(symbolFilePath);
            var checkMode = product.cpp.exportedSymbolsCheckMode;
            var oldSymbols;
            var newSymbols;
            if (checkMode === "strict") {
                oldSymbols = oldNmResult.allGlobalSymbols;
                newSymbols = newNmResult.allGlobalSymbols;
            } else {
                oldSymbols = oldNmResult.definedGlobalSymbols;
                newSymbols = newNmResult.definedGlobalSymbols;
            }
            if (oldSymbols.length !== newSymbols.length) {
                console.debug("List of relevant symbols differs for '" + libFilePath + "'.");
                createSymbolFile(symbolFilePath, newNmResult.allGlobalSymbols,
                                 newNmResult.definedGlobalSymbols);
                return;
            }
            for (var i = 0; i < oldSymbols.length; ++i) {
                var oldLine = oldSymbols[i];
                var newLine = newSymbols[i];
                var oldLineElems = oldLine.split(/\s+/);
                var newLineElems = newLine.split(/\s+/);
                if (oldLineElems[0] !== newLineElems[0] // Object name.
                        || oldLineElems[1] !== newLineElems[1]) { // Object type
                    console.debug("List of relevant symbols differs for '" + libFilePath + "'.");
                    createSymbolFile(symbolFilePath, newNmResult.allGlobalSymbols,
                                     newNmResult.definedGlobalSymbols);
                    return;
                }
            }
        }
        commands.push(cmd);
    }
    return commands;
}

function prepareLinker(project, product, inputs, outputs, input, output) {
    var i, primaryOutput, cmd, commands = [];

    if (outputs.application) {
        primaryOutput = outputs.application[0];
    } else if (outputs.dynamiclibrary) {
        primaryOutput = outputs.dynamiclibrary[0];
    } else if (outputs.loadablemodule) {
        primaryOutput = outputs.loadablemodule[0];
    }

    var linkerPath = effectiveLinkerPath(product, inputs)

    var args = linkerFlags(project, product, inputs, primaryOutput, linkerPath);
    var wrapperArgsLength = 0;
    var wrapperArgs = product.cpp.linkerWrapper;
    if (wrapperArgs && wrapperArgs.length > 0) {
        wrapperArgsLength = wrapperArgs.length;
        args.unshift(linkerPath);
        linkerPath = wrapperArgs.shift();
        args = wrapperArgs.concat(args);
    }

    var responseFileArgumentIndex = wrapperArgsLength;

    // qcc doesn't properly handle response files, so we have to do it manually
    var useQnxResponseFileHack = product.qbs.toolchain.contains("qcc")
            && useCompilerDriverLinker(product, inputs);
    if (useQnxResponseFileHack) {
        // qcc needs to see at least one object/library file to think it has something to do,
        // so start the response file at the second object file (so, 3 after the last -o option)
        var idx = args.lastIndexOf("-o");
        if (idx !== -1 && idx + 3 < args.length)
            responseFileArgumentIndex += idx + 3;
    }

    cmd = new Command(linkerPath, args);
    cmd.description = 'linking ' + primaryOutput.fileName + nativeConfigString(product);
    cmd.highlight = 'linker';
    cmd.relevantEnvironmentVariables = linkerEnvVars(product, inputs);
    cmd.responseFileArgumentIndex = responseFileArgumentIndex;
    cmd.responseFileUsagePrefix = useQnxResponseFileHack ? "-Wl,@" : "@";
    commands.push(cmd);

    var debugInfo = outputs.debuginfo_app || outputs.debuginfo_dll
            || outputs.debuginfo_loadablemodule;
    if (debugInfo) {
        if (product.qbs.targetOS.contains("darwin")) {
            if (!product.aggregate) {
                var dsymPath = debugInfo[0].filePath;
                if (outputs.debuginfo_bundle && outputs.debuginfo_bundle[0])
                    dsymPath = outputs.debuginfo_bundle[0].filePath;
                var flags = product.cpp.dsymutilFlags || [];
                cmd = new Command(product.cpp.dsymutilPath, flags.concat([
                    "-o", dsymPath, primaryOutput.filePath
                ]));
                cmd.description = "generating dSYM for " + product.name;
                commands.push(cmd);

                cmd = new Command(product.cpp.stripPath,
                                  ["-S", primaryOutput.filePath]);
                cmd.silent = true;
                commands.push(cmd);
            }
        } else {
            var objcopy = product.cpp.objcopyPath;

            cmd = new Command(objcopy, ["--only-keep-debug", primaryOutput.filePath,
                                        debugInfo[0].filePath]);
            cmd.silent = true;
            commands.push(cmd);

            cmd = new Command(objcopy, ["--strip-debug", primaryOutput.filePath]);
            cmd.silent = true;
            commands.push(cmd);

            cmd = new Command(objcopy, ["--add-gnu-debuglink=" + debugInfo[0].filePath,
                                        primaryOutput.filePath]);
            cmd.silent = true;
            commands.push(cmd);
        }
    }

    if (outputs.dynamiclibrary) {
        Array.prototype.push.apply(commands, createSymbolCheckingCommands(product, outputs));

        // Create symlinks from {libfoo, libfoo.1, libfoo.1.0} to libfoo.1.0.0
        var links = outputs["dynamiclibrary_symlink"];
        var symlinkCount = links ? links.length : 0;
        for (i = 0; i < symlinkCount; ++i) {
            cmd = new Command("ln", ["-sf", primaryOutput.fileName,
                                     links[i].filePath]);
            cmd.highlight = "filegen";
            cmd.description = "creating symbolic link '"
                    + links[i].fileName + "'";
            cmd.workingDirectory = FileInfo.path(primaryOutput.filePath);
            commands.push(cmd);
        }
    }

    if (product.xcode && product.bundle) {
        var actualSigningIdentity = product.xcode.actualSigningIdentity;
        var codesignDisplayName = product.xcode.actualSigningIdentityDisplayName;
        if (actualSigningIdentity && !product.bundle.isBundle) {
            args = product.xcode.codesignFlags || [];
            args.push("--force");
            args.push("--sign", actualSigningIdentity);
            args = args.concat(DarwinTools._codeSignTimestampFlags(product));

            for (var j in inputs.xcent) {
                args.push("--entitlements", inputs.xcent[j].filePath);
                break; // there should only be one
            }
            args.push(primaryOutput.filePath);
            cmd = new Command(product.xcode.codesignPath, args);
            cmd.description = "codesign "
                    + primaryOutput.fileName
                    + " using " + codesignDisplayName
                    + " (" + actualSigningIdentity + ")";
            commands.push(cmd);
        }
    }

    return commands;
}

function concatLibsFromArtifacts(libs, artifacts, filePathGetter)
{
    if (!artifacts)
        return libs;
    if (!filePathGetter)
        filePathGetter = function (a) { return a.filePath; };
    var deps = artifacts.map(filePathGetter);
    deps.reverse();
    return concatLibs(deps, libs);
}

function debugInfoArtifacts(product, variants, debugInfoTagSuffix) {
    var fileTag;
    switch (debugInfoTagSuffix) {
    case "app":
        fileTag = "application";
        break;
    case "dll":
        fileTag = "dynamiclibrary";
        break;
    default:
        fileTag = debugInfoTagSuffix;
        break;
    }

    variants = variants || [{}];

    var artifacts = [];
    if (product.cpp.separateDebugInformation) {
        variants.map(function (variant) {
            artifacts.push({
                filePath: FileInfo.joinPaths(product.destinationDirectory,
                                                 PathTools.debugInfoFilePath(product,
                                                                             variant.suffix,
                                                                             fileTag)),
                fileTags: ["debuginfo_" + debugInfoTagSuffix]
            });
        });
        if (PathTools.debugInfoIsBundle(product)) {
            artifacts.push({
                filePath: FileInfo.joinPaths(product.destinationDirectory,
                                             PathTools.debugInfoBundlePath(product, fileTag)),
                fileTags: ["debuginfo_bundle"]
            });
            artifacts.push({
                filePath: FileInfo.joinPaths(product.destinationDirectory,
                                             PathTools.debugInfoPlistFilePath(product, fileTag)),
                fileTags: ["debuginfo_plist"]
            });
        }
    }
    return artifacts;
}

function isNumericProductVersion(version) {
    return version && version.match(/^([0-9]+\.){0,3}[0-9]+$/);
}

function dumpMacros(env, compilerFilePath, args, nullDevice) {
    var p = new Process();
    try {
        p.setEnv("LC_ALL", "C");
        for (var key in env)
            p.setEnv(key, env[key]);
        // qcc NEEDS the explicit -Wp, prefix to -dM; clang and gcc do not but all three accept it
        p.exec(compilerFilePath,
               (args || []).concat(["-Wp,-dM", "-E", "-x", "c", nullDevice]), true);
        var map = {};
        p.readStdOut().trim().split("\n").map(function (line) {
            var parts = line.split(" ", 3);
            map[parts[1]] = parts[2];
        });
        return map;
    } finally {
        p.close();
    }
}

function dumpDefaultPaths(env, compilerFilePath, args, nullDevice, pathListSeparator, sysroot) {
    var p = new Process();
    try {
        p.setEnv("LC_ALL", "C");
        for (var key in env)
            p.setEnv(key, env[key]);
        args = args || [];
        p.exec(compilerFilePath, args.concat(["-v", "-E", "-x", "c++", nullDevice]), true);
        var suffix = " (framework directory)";
        var includePaths = [];
        var libraryPaths = [];
        var frameworkPaths = [];
        var addIncludes = false;
        var lines = p.readStdErr().trim().split("\n").map(function (line) { return line.trim(); });
        for (var i = 0; i < lines.length; ++i) {
            var line = lines[i];
            var prefix = "LIBRARY_PATH=";
            if (line.startsWith(prefix)) {
                libraryPaths = libraryPaths.concat(line.substr(prefix.length)
                                                   .split(pathListSeparator));
            } else if (line === "#include <...> search starts here:") {
                addIncludes = true;
            } else if (line === "End of search list.") {
                addIncludes = false;
            } else if (addIncludes) {
                if (line.endsWith(suffix))
                    frameworkPaths.push(line.substr(0, line.length - suffix.length));
                else
                    includePaths.push(line);
            }
        }

        sysroot = sysroot || "";

        if (includePaths.length === 0)
            includePaths.push(sysroot + "/usr/include", sysroot + "/usr/local/include");

        if (libraryPaths.length === 0)
            libraryPaths.push(sysroot + "/lib", sysroot + "/usr/lib");

        if (frameworkPaths.length === 0)
            frameworkPaths.push(sysroot + "/System/Library/Frameworks");

        return {
            "includePaths": includePaths,
            "libraryPaths": libraryPaths,
            "frameworkPaths": frameworkPaths
        };
    } finally {
        p.close();
    }
}

function targetFlags(tool, hasTargetOption, target, targetArch, machineType, targetOS) {
    var args = [];
    if (hasTargetOption) {
        if (target)
            args.push("-target", target);
    } else {
        var archArgs = {
            "compiler": {
                "i386": ["-m32"],
                "x86_64": ["-m64"],
            },
            "linker": {
                "i386": ["-m", targetOS.contains("windows") ? "i386pe" : "elf_i386"],
                "x86_64": ["-m", targetOS.contains("windows") ? "i386pep" : "elf_x86_64"],
            },
            "assembler": {
                "i386": ["--32"],
                "x86_64": ["--64"],
            },
        };

        var flags = archArgs[tool] ? archArgs[tool][targetArch] : undefined;
        if (flags)
            args = args.concat(flags);

        if (machineType && tool !== "linker")
            args.push("-march=" + machineType);
    }
    return args;
}

function toolNames(rawToolNames, toolchainPrefix)
{
    return toolchainPrefix
            ? rawToolNames.map(function(rawName) { return toolchainPrefix + rawName; })
            : rawToolNames;
}

function pathPrefix(baseDir, prefix)
{
    var path = '';
    if (baseDir) {
        path += baseDir;
        if (path.substr(-1) !== '/')
            path += '/';
    }
    if (prefix)
        path += prefix;
    return path;
}
