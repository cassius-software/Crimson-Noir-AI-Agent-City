#Requires -Version 5.1
<#
.SYNOPSIS
    Publishes the release tags of Crimson Noir AI Agent City from the operator's own machine.

.DESCRIPTION
    Why does this file exist? The agent sessions that build this project cannot push tags: their git proxy answers
    HTTP 403 to a tag push. This script is the operator's way to do it, with the operator's own GitHub credentials.
    It changes nothing but the tags:
    1. It works on the clone it lives in. It checks that every fetch and push URL of the remote names the expected
       repository, and that git has a tagger to sign annotated tags as.
    2. It fetches origin explicitly (no tags, no pruning, so the operator's own local tags are left alone), including
       the branch the commit was pushed on.
    3. It resolves -Commit to a full commit and requires it to be on that branch as origin has it. The default is a
       full hash: a short prefix could be matched by a look-alike commit pushed to the branch.
    4. For each tag (at most three: GitHub starts no workflow for a push of more):
       - if origin already has it at this commit, nothing is done;
       - if origin has it at another commit, it stops. -Force moves it, and says so loudly;
       - it is made locally as an annotated tag (signed with -Sign). A local tag at the same commit is reused only if
         it is annotated, and signed when -Sign asks for it.
    5. It pushes the tags in one atomic push, a moved tag only on a lease of what origin had. Then it reads them back
       from origin to prove where they landed.
    A tag push starts .github/workflows/build-release.yml only if the tagged commit contains that file and the tag
    matches v* or stable-*. GitHub runs the workflow as it is at the tagged commit. The script says which it is
    before pushing anything.
    -WhatIf shows every step without making or pushing a tag.
    What breaks if it is removed? Nothing at run time; the release tags stay unpublished.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\publish.ps1 -WhatIf
    Shows what would be tagged and pushed, and does neither. (-ExecutionPolicy Bypass is for this one run only.)

.EXAMPLE
    .\publish.ps1
    Tags cb99379 (the full hash is the default) as v1.0.0-stable-release and stable-beta and pushes both to origin.

.EXAMPLE
    .\publish.ps1 -Commit 0123abcd...
    Tags another commit of the published branch instead, for example one that contains the release workflow.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # The commit to tag: a full hash is safest; any name git resolves to a commit is accepted.
    [string] $Commit = 'cb99379e562e138532040ea387d4bca368569a40',
    # One to three tag names (letters, digits, dots, dashes and underscores). 'a,b' is read as two.
    [string[]] $Tags = @('v1.0.0-stable-release', 'stable-beta'),
    [string] $Remote = 'origin',
    # The branch on the remote that must contain the commit.
    [string] $Branch = 'claude/quirky-faraday-xkpdln',
    # owner/name every URL of the remote must end in, so the script never tags another repository by mistake.
    [string] $Repository = 'exitwoundscassius-ux/Crimson-Noir-AI-Agent-City',
    # Sign the tags with the operator's GPG or SSH signing key (git tag -s).
    [switch] $Sign,
    # Move a tag that already exists at another commit, locally and on the remote. Rewrites published history.
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# PowerShell 7.3+ could turn a native command's exit code into an error by itself; this script checks every exit code.
$PSNativeCommandUseErrorActionPreference = $false

# Runs git; returns its standard output and standard error as separate lines of text, and its exit code. Windows
# PowerShell would raise git's standard error (progress, warnings) as an error, so it is collected instead.
function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)] [string[]] $Arguments,
        [switch] $AllowFailure
    )
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $all = @(& git @Arguments 2>&1)
    }
    finally {
        $ErrorActionPreference = $previous
    }
    $code = $LASTEXITCODE
    $output = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" })
    $errors = @($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object {
            $text = if ($_.TargetObject -is [string]) { $_.TargetObject } else { $_.Exception.Message }
            if ($text -eq 'System.Management.Automation.RemoteException') { '' } else { $text }
        })
    if ($code -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') failed with exit code ${code}:`n$((@($errors) + @($output)) -join "`n")"
    }
    return [pscustomobject]@{ Code = $code; Output = $output; Errors = $errors }
}

# The first line of a git call's standard output, or $null.
function Get-First {
    param($Result)
    if ($Result.Output.Count -gt 0) { return $Result.Output[0] }
    return $null
}

# A tag as the remote has it: the object it names and the commit that peels to, or $null when there is no such tag.
function Get-RemoteTag {
    param([Parameter(Mandatory = $true)] [string] $Name)
    $lines = (Invoke-Git -Arguments @('ls-remote', '--tags', $Remote, "refs/tags/$Name", "refs/tags/$Name^{}")).Output
    $object = $null
    $peeled = $null
    foreach ($line in $lines) {
        $parts = $line -split '\s+'
        if ($parts.Count -lt 2) { continue }
        if ($parts[1] -eq "refs/tags/$Name^{}") { $peeled = $parts[0] }
        elseif ($parts[1] -eq "refs/tags/$Name") { $object = $parts[0] }
    }
    if ($null -eq $object) { return $null }
    if ($null -eq $peeled) { $peeled = $object }
    return [pscustomobject]@{ Object = $object; Commit = $peeled }
}

# A URL fit to print: any credentials in it hidden.
function Hide-Credential {
    param([string] $Url)
    return ($Url -replace '://[^/@]+@', '://***@')
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is not on PATH.' }

# Git writes UTF-8; read it as UTF-8 whatever the console's code page (restored at the end).
$previousEncoding = $null
try {
    $previousEncoding = [Console]::OutputEncoding
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
}
catch {
    Write-Verbose "The console's output encoding stays as it is: $_"
}

$pushed = $false
try {
    # The tag names: 'a,b' (as -File passes it) is two names; one to three, each one the release workflow accepts.
    $names = @($Tags | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ($names.Count -lt 1 -or $names.Count -gt 3) {
        throw "Give one to three tags (GitHub starts no workflow for a push of more than three); got $($names.Count)."
    }
    foreach ($tag in $names) {
        if ($tag -notmatch '^[A-Za-z0-9._][A-Za-z0-9._-]*$' -or (Invoke-Git -Arguments @('check-ref-format', "refs/tags/$tag") -AllowFailure).Code -ne 0) {
            throw "'$tag' is not a tag name the release workflow accepts (letters, digits, dots, dashes, underscores)."
        }
    }

    # 1. This script's own clone; every URL of the remote naming the repository; someone to sign the tags as.
    $here = $PSScriptRoot
    if ([string]::IsNullOrEmpty($here)) { $here = (Get-Location).Path }
    $top = Get-First (Invoke-Git -Arguments @('-C', $here, 'rev-parse', '--show-toplevel'))
    Push-Location -LiteralPath $top
    try {
        $wanted = '(^|[/:])' + [regex]::Escape($Repository) + '(\.git)?/?$'
        $urls = @((Invoke-Git -Arguments @('remote', 'get-url', '--all', $Remote)).Output) +
            @((Invoke-Git -Arguments @('remote', 'get-url', '--push', '--all', $Remote)).Output)
        foreach ($url in $urls) {
            if ($url -notmatch $wanted) {
                throw "Remote '$Remote' has the URL $(Hide-Credential $url), not $Repository. Run this in a clone of $Repository, or pass -Repository."
            }
        }
        $who = Get-First (Invoke-Git -Arguments @('config', 'user.email') -AllowFailure)
        if ([string]::IsNullOrWhiteSpace($who)) {
            throw 'git has no user.email; annotated tags need a tagger: git config --global user.email you@example.com'
        }
        Write-Host "Repository: $(Hide-Credential $urls[0]) (tagger $who)"

        # 2. Fetch origin explicitly, and the branch the commit must be on; no tags, nothing pruned.
        Write-Host "Fetching $Remote ..."
        Invoke-Git -Arguments @('fetch', '--no-tags', '--no-prune', $Remote) | Out-Null
        $branchFetch = Invoke-Git -Arguments @('fetch', '--no-tags', $Remote, "+refs/heads/${Branch}:refs/remotes/$Remote/$Branch") -AllowFailure
        if ($branchFetch.Code -ne 0) {
            throw "$Remote has no branch '$Branch' (merged and deleted?): pass -Branch with the branch the commit is on.`n$($branchFetch.Errors -join "`n")"
        }

        # 3. The commit, in full, and on the published branch.
        $resolved = Invoke-Git -Arguments @('rev-parse', '--verify', "$Commit^{commit}") -AllowFailure
        if ($resolved.Code -ne 0) {
            $hint = ''
            if ((Get-First (Invoke-Git -Arguments @('rev-parse', '--is-shallow-repository') -AllowFailure)) -eq 'true') {
                $hint = ' This clone is shallow: git fetch --unshallow, then run again.'
            }
            throw "'$Commit' is not one commit in this clone.$hint`n$($resolved.Errors -join "`n")"
        }
        $sha = Get-First $resolved
        $branchRef = "refs/remotes/$Remote/$Branch"
        if ((Invoke-Git -Arguments @('merge-base', '--is-ancestor', $sha, $branchRef) -AllowFailure).Code -ne 0) {
            throw "$sha is not on $Remote/${Branch}: only published history is tagged."
        }
        $subject = Get-First (Invoke-Git -Arguments @('log', '-1', '--format=%s', $sha))
        Write-Host "Commit:     $sha ($subject)"
        $hasWorkflow = (Invoke-Git -Arguments @('cat-file', '-e', "${sha}:.github/workflows/build-release.yml") -AllowFailure).Code -eq 0

        # 4. Each tag: already published here, refused elsewhere (unless -Force), made or reused locally.
        $refspecs = New-Object System.Collections.Generic.List[string]
        $leases = New-Object System.Collections.Generic.List[string]
        foreach ($tag in $names) {
            $remoteTag = Get-RemoteTag -Name $tag
            if ($null -ne $remoteTag -and $remoteTag.Commit -eq $sha) {
                Write-Host "Tag $tag is already on $Remote at $($sha.Substring(0, 12)): nothing to do."
                continue
            }
            if ($null -ne $remoteTag) {
                if (-not $Force) {
                    throw "$Remote already has $tag at $($remoteTag.Commit), not $sha. Moving a published tag rewrites history; pass -Force only if that is intended."
                }
                Write-Warning "-Force: $tag will be MOVED on $Remote from $($remoteTag.Commit) to $sha."
                $leases.Add("--force-with-lease=refs/tags/${tag}:$($remoteTag.Object)")
            }

            $local = Invoke-Git -Arguments @('rev-parse', '--verify', '--quiet', "refs/tags/$tag^{commit}") -AllowFailure
            $localAt = Get-First $local
            $reuse = $false
            if ($local.Code -eq 0 -and $localAt -eq $sha) {
                $annotated = (Get-First (Invoke-Git -Arguments @('cat-file', '-t', "refs/tags/$tag"))) -eq 'tag'
                $signed = (-not $Sign) -or ((Invoke-Git -Arguments @('tag', '-v', $tag) -AllowFailure).Code -eq 0)
                $reuse = $annotated -and $signed
                if (-not $reuse -and -not $Force) {
                    throw "The local tag $tag points at this commit but is $(if (-not $annotated) { 'not annotated' } else { 'not signed' }). Delete it (git tag -d $tag) or pass -Force."
                }
            }
            elseif ($local.Code -eq 0 -and -not $Force) {
                throw "The local tag $tag points at $localAt, not $sha. Delete it (git tag -d $tag) or pass -Force."
            }

            if ($reuse) {
                Write-Host "Tag $tag already points at $($sha.Substring(0, 12)) locally, annotated$(if ($Sign) { ' and signed' })."
            }
            elseif ($PSCmdlet.ShouldProcess("$tag -> $sha", 'Create annotated tag')) {
                if ($local.Code -eq 0) {
                    $was = if ($localAt -eq $sha) { 'it was not annotated, or not signed' } else { "it was at $localAt" }
                    Write-Warning "-Force: the local tag $tag is remade at $sha ($was)."
                }
                $message = "$tag`n`nCrimson Noir AI Agent City at $($sha.Substring(0, 12)): $subject`nPublished with publish.ps1 by $who."
                $file = [System.IO.Path]::GetTempFileName()
                try {
                    # UTF-8 without a byte-order mark, which git would otherwise keep at the start of the message.
                    [System.IO.File]::WriteAllText($file, $message, (New-Object System.Text.UTF8Encoding($false)))
                    $create = @('tag', $(if ($Sign) { '-s' } else { '-a' }))
                    if ($local.Code -eq 0) { $create += '-f' }
                    Invoke-Git -Arguments ($create + @('-F', $file, $tag, $sha)) | Out-Null
                }
                finally {
                    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
                }
                Write-Host "Tag $tag created at $($sha.Substring(0, 12))."
            }
            $refspecs.Add("refs/tags/${tag}:refs/tags/$tag")
        }

        if ($refspecs.Count -eq 0) {
            Write-Host "Every tag is already on $Remote at $($sha.Substring(0, 12))."
            return
        }

        # What the push will start, before it happens.
        $baked = @($names | Where-Object { $_ -match '^(v|stable-)' })
        if ($hasWorkflow -and $baked.Count -gt 0) {
            Write-Host "Pipeline:   this commit has the release workflow; pushing $($baked -join ' and ') starts a bake for each."
        }
        elseif (-not $hasWorkflow) {
            $tip = Get-First (Invoke-Git -Arguments @('rev-parse', $branchRef))
            $tipHas = (Invoke-Git -Arguments @('cat-file', '-e', "${tip}:.github/workflows/build-release.yml") -AllowFailure).Code -eq 0
            $instead = if ($tipHas) { " To bake them, tag the branch's head instead, which has it: -Commit $tip." } else { '' }
            Write-Warning ("$($sha.Substring(0, 12)) predates .github/workflows/build-release.yml, so these tags start no release " +
                "bake (GitHub runs the workflow as it is at the tagged commit).$instead Or, once the workflow is on the " +
                'default branch, run it by hand for each tag: gh workflow run build-release.yml -f tag=<tag>.')
        }

        # 5. One atomic push of every tag that needs it (a moved tag only on its lease), then the remote read back.
        if (-not $PSCmdlet.ShouldProcess("$Remote ($($refspecs -join ', '))", 'Push tags')) { return }
        Invoke-Git -Arguments (@('push', '--atomic') + $leases.ToArray() + @($Remote) + $refspecs.ToArray()) | Out-Null
        $pushed = $true
        foreach ($tag in $names) {
            $at = Get-RemoteTag -Name $tag
            if ($null -eq $at -or $at.Commit -ne $sha) { throw "After the push, $Remote does not have $tag at $sha." }
            Write-Host "Published: $tag -> $sha"
        }
        $web = 'https://github.com/' + $Repository
        if ($hasWorkflow -and $baked.Count -gt 0) { Write-Host "Release bakes: $web/actions/workflows/build-release.yml" }
        Write-Host "Releases:      $web/releases"
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -ne $previousEncoding) {
        try { [Console]::OutputEncoding = $previousEncoding } catch { Write-Verbose "$_" }
    }
    if ($pushed) { Write-Verbose 'Tags pushed.' }
}
