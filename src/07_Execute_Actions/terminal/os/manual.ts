// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the manual pages that belong to no single program: where to start (`man
 * intro`), the shell and everything it understands (`man sh`), and the tree of directories and what is kept between
 * visits (`man files`). Each page says only what the layer does today, including what a person used to other
 * shells would expect and will not find.
 * What breaks if it is removed? `man intro` finds nothing, and the shell's own rules are written down nowhere a
 * person at the prompt can read them.
 */

const INTRO = `NAME
    intro - where to start with the files and programs of this console

USAGE
    man intro

WHAT IT DOES
    This prompt is two things at once. It is the city's console: help
    lists its commands (stats, time, quality and the rest), and each of
    them works as it always has. It is also a small operating system of
    its own: a tree of directories, programs that read and write files,
    and a shell that joins them together.

    Nothing here can reach the machine you are sitting at. The files
    live inside this page, and the programs see only what this system
    hands them.

FIRST STEPS
    ls              the files in the directory you are in
    ls /bin         every program
    man ls          what one of them does (man alone lists every page)
    cat README      print a file
    pwd             where you are; cd /tmp goes somewhere else
    echo hi > note  put text in a file; cat note prints it back

JOINING PROGRAMS
    A | between two commands hands the output of the first to the
    second, and > file sends output to a file instead of the screen:

    ls /bin | wc -l              how many programs there are
    stats --once | grep fps      one line of a console command
    laws > laws.txt              keep what a command printed

THE CITY AS FILES
    The city can be read as files under /proc/city and set by writing
    to files under /sys/city. man city has the list.

KEYS
    Tab completes a command or a file name. Up and Down recall earlier
    lines. Ctrl+C stops the program that is running. Ctrl+D on an empty
    line ends the input of a program that is reading what you type. On
    a touch screen the Stop and End input buttons do the same.

SEE ALSO
    man sh (the shell), man files (the directories and what is kept),
    man city (the city as files)
`

const SH = `NAME
    sh - the shell: reads commands and runs them

USAGE
    sh [script [argument ...]]
    sh -c 'commands' [name [argument ...]]

WHAT IT DOES
    The shell is what reads the line you type. It splits the line into
    words, replaces variables and patterns, and runs the program the
    first word names. Given a file it runs the commands in the file,
    which is how a script works: a text file that starts with the line
    #!/bin/sh and may be run (chmod +x file) runs by its name.

WORDS AND QUOTES
    Blanks separate words. 'single quotes' keep everything inside as it
    is. "double quotes" keep blanks but still replace $variables and
    $(commands). A backslash keeps the one character after it. A # at
    the start of a word begins a comment that runs to the end of the
    line.

VARIABLES
    NAME=value        set one (no blanks around the =)
    $NAME, \${NAME}    its value
    \${NAME:-word}     the value, or word when it is unset or empty
    \${NAME:=word}     the same, and NAME is set to word
    \${NAME:+word}     word when NAME is set and not empty
    \${NAME:?message}  the value, or stop with the message
    \${#NAME}          how many characters it holds
    \${NAME%pat} \${NAME%%pat} \${NAME#pat} \${NAME##pat}
                      the value with the shortest or longest match of a
                      pattern cut from its end (%) or its start (#)
    export NAME       hand it on to the programs the shell runs
    $?  the status of the last command (0 means it worked)
    $$  the shell's own number   $!  the last background job's number
    $1 $2 ...  a script's arguments; $# how many; $@ all of them
    ~   your home directory, at the start of a word

REPLACING COMMANDS AND SUMS
    $(command)        the output of a command, as words
    $((2 + 3 * 4))    whole-number arithmetic: + - * / % ( ) comparisons
                      and variables by name

PATTERNS
    *  any run of characters   ?  any one   [abc] [a-z]  one of a set
    A word with a pattern becomes the matching file names, in order; a
    pattern that matches nothing stays as typed. Names that start with a
    dot are matched only by a pattern that starts with one.

JOINING COMMANDS
    a | b       the output of a becomes the input of b
    a ; b       a, then b
    a && b      b only if a worked      a || b   b only if a failed
    a &         run a in the background and take the next line at once
    ! a         a, with its status turned around
    { a; b; }   a group, to redirect or join as one

REDIRECTION
    > file      output to a file (replacing it)   >> file  added to it
    < file      input from a file
    2> file     error messages to a file          2>&1     to where
                output goes
    << WORD     the lines that follow, up to a line that is only WORD,
                are the input (<<- also strips leading tabs)

CONDITIONS AND LOOPS
    if list; then list; elif list; then list; else list; fi
    while list; do list; done        until list; do list; done
    for name in words; do list; done
    break and continue leave or restart a loop; return ends a script
    that was read with source.
    test and [ ] compare text and numbers and ask about files:
    man test.

COMMANDS OF THE SHELL ITSELF
    cd [dir]  pwd  echo [-n] [-e] [text]  read name ...  export  unset
    exit [status]  source file (also . file)  type name  umask [mode]
    shift  true  false  :  test  [
    jobs   the background jobs      wait [job]   wait for them
    fg [job]   bring one back to the terminal
    stop job   end one (stop %1, or stop with a task's number)

THE CITY'S COMMANDS
    The console's own commands (help lists them) can be used in a pipe,
    a list or a redirection like any program. Each keeps its own way of
    reading its arguments: nothing in them is replaced or expanded, and
    it ends at a | || && ; & or redirection that stands alone as a
    word. The commands that take the rest of the line whole (run, ask,
    say, noir, r0 and a few more) still do. Inside a pipe or a file a
    command gives its lines only: clearing the screen, closing the
    console or a live view happen only when it is typed at the prompt.

WHAT IT DOES NOT DO
    There are no functions, no case, no ( ) subshells, no set, no
    arrays, no backquotes (the key toggles the console; use $( )), no
    stopping a job with a key and resuming it, and no aliases. A script
    written for a larger shell may need changes.

STATUS
    The status of the last command it ran; 2 for a line it could not
    read; 127 when a command was not found; 130 after Ctrl+C.

EXAMPLE
    for f in *.txt; do wc -l < "$f"; done
`

const FILES = `NAME
    files - the directories of this system, and what is kept

USAGE
    man files

WHAT IT DOES
    Describes the tree. Paths start at / and use / between names; . is
    the directory you are in and .. the one above it.

THE TREE
    /home/operator   your home directory (~). Kept between visits.
    /etc             a few settings of the system. Kept.
    /mnt             an empty place for drives to be attached. Kept.
    /tmp             scratch space. Emptied when the page closes.
    /bin             the programs. Read-only: part of the page.
    /usr/share/man   the manual pages. Read-only.
    /usr/apps        a place for applications. Read-only.
    /dev             devices: null (swallows what is written), zero,
                     full, random, urandom, tty (the terminal).
    /proc            the running tasks, one directory each, and the
                     city's readings under /proc/city.
    /sys             knobs: the city's under /sys/city.

WHAT IS KEPT
    Everything outside /tmp, /bin, /usr, /dev, /proc and /sys is one
    disk of 8 MiB, saved in this browser's own storage for this site a
    moment after it changes and when the page is hidden. It comes back
    the next time the page is opened in the same browser. It is not
    sent anywhere, and another browser or device has its own.

    If the browser gives the page no storage (some private windows),
    or a second tab of the site has saved a newer disk, the console
    says once that files are no longer kept, and they then last until
    the page closes. Clearing the site's data in the browser erases the
    disk. df shows how full each part is.

PERMISSIONS
    Each file has an owner and three sets of read, write and run bits
    (ls -l shows them, chmod changes them). You are root at the prompt,
    so the bits matter for which files run as programs (the run bit) and
    for programs that run as someone else.

LIMITS
    A name is at most 255 bytes and a path 4096. There are no links.
    Times are in UTC. A file under /proc or /sys is made when it is
    read, so its size shows as 0 until then.

SEE ALSO
    man intro, man sh, man city, man df, man ls, man chmod
`

/** The pages that belong to no single program. */
export const OS_MANUAL: Readonly<Record<string, string>> = Object.freeze({ intro: INTRO, sh: SH, files: FILES })
