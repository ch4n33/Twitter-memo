// chrome.storage.local.set();
// chrome.storage.local.get();
// chrome.storage.local.clear();

function getMemo(id) {
    res = "";
    chrome.storage.local.get(id, function(result) {
        res = result;
    });
    return res;
}

function getId() {
    var a = document.querySelectorAll('head > script:nth-child(49)')
    var b = Array.from(a)
    var c = b.map((x) => x.innerText);
    var data = c[0];

    if (data === undefined) {
        console.log('data is not found in document');
    }
    return JSON.parse(data)['author'];
}

console.log(document.location.href);
if (document.location.href !== "https://twitter.com/home") {
    var Id = getId();

    var memo = getMemo(Id.identifier);
    console.log('found memo ' + memo);
    console.log('found id ' + Id.identifier);
    chrome.runtime.sendMessage({'id': Id.identifier, 'memo':memo}, function(response) {
        console.log(response);
      });
}