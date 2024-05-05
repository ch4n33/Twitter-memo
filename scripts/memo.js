


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
r = /^https:\/\/twitter\.com\/(?!home$).+/;

if (r.test(window.location.href)) {
    var Id = getId();
    console.log('found id ' + Id.identifier);
    chrome.runtime.sendMessage({'id': Id.identifier}, function(response) {
        console.log(response);
      });
}